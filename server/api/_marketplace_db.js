const { Pool } = require('pg');
const {
  currentGame,
  databaseUrlForGame,
  isPokemonGame,
  normalizeGame,
} = require('./_marketplace_game');

let pool;
const gamePools = new Map();
let nameSearchPool;
let variationSearchPools = [];
let variationSearchPoolIndex = 0;
let variationSearchPoolKey = '';
let readReplicaPools = [];
let readReplicaPoolIndex = 0;
let readReplicaPoolKey = '';
let assistantReadOnlyPool;
let supabaseNameIndexPool;
let writerPool;
let writerPoolKey = '';
let dimensionSearchPools = new Map();
let dimensionSearchPoolKey = '';

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function marketplaceDatabaseUrl() {
  return process.env.MARKETPLACE_DATABASE_URL || process.env.MARKETPLACE_PEER4_DATABASE_URL || '';
}

function marketplaceWriterDatabaseUrl() {
  return process.env.MARKETPLACE_WRITER_DATABASE_URL || marketplaceDatabaseUrl();
}

function marketplaceAssistantReadOnlyDatabaseUrl() {
  return process.env.POKO_ASSISTANT_READONLY_DATABASE_URL ||
    process.env.MARKETPLACE_ASSISTANT_READONLY_DATABASE_URL ||
    process.env.MARKETPLACE_PEER4_READONLY_DATABASE_URL ||
    marketplaceAnalyticsSearchDatabaseUrls()[0] ||
    marketplaceDatabaseUrl();
}

function marketplaceAssistantReadOnlyConfigured() {
  return Boolean(
    process.env.POKO_ASSISTANT_READONLY_DATABASE_URL ||
    process.env.MARKETPLACE_ASSISTANT_READONLY_DATABASE_URL ||
    process.env.MARKETPLACE_PEER4_READONLY_DATABASE_URL,
  );
}

function marketplaceNameSearchDatabaseUrl() {
  return process.env.MARKETPLACE_NAME_SEARCH_DATABASE_URL ||
    process.env.MARKETPLACE_PEER3_DATABASE_URL ||
    marketplaceDatabaseUrl();
}

function supabaseNameIndexDatabaseUrl() {
  return process.env.SUPABASE_NAME_INDEX_DATABASE_URL ||
    process.env.SUPABASE_DB_POOLER_URL ||
    process.env.SUPABASE_DB_URL ||
    '';
}

function supabaseNameIndexConfigured() {
  return Boolean(supabaseNameIndexDatabaseUrl());
}

function marketplaceVariationSearchDatabaseUrls() {
  const urls = configuredMarketplaceVariationSearchDatabaseUrls();
  return urls.length > 0 ? urls : [marketplaceDatabaseUrl()].filter(Boolean);
}

function configuredMarketplaceVariationSearchDatabaseUrls() {
  if (process.env.MARKETPLACE_VARIATION_SEARCH_REPLICA_URLS) {
    return uniqueStrings(String(process.env.MARKETPLACE_VARIATION_SEARCH_REPLICA_URLS).split(','));
  }
  if (process.env.MARKETPLACE_VARIATION_SEARCH_DATABASE_URL) {
    return uniqueStrings([process.env.MARKETPLACE_VARIATION_SEARCH_DATABASE_URL]);
  }
  return uniqueStrings([
    process.env.MARKETPLACE_PEER2_DATABASE_URL,
    process.env.MARKETPLACE_PEER1_DATABASE_URL,
  ]);
}

function configuredMarketplaceReadReplicaDatabaseUrls() {
  const primaryUrl = marketplaceDatabaseUrl();
  return uniqueStrings([
    ...configuredMarketplaceVariationSearchDatabaseUrls(),
    marketplaceNameSearchDatabaseUrl(),
    process.env.MARKETPLACE_PEER3_DATABASE_URL,
    process.env.MARKETPLACE_PEER2_DATABASE_URL,
    process.env.MARKETPLACE_PEER1_DATABASE_URL,
  ]).filter((url) => url !== primaryUrl);
}

function marketplaceAnalyticsSearchDatabaseUrls() {
  const rawUrls =
    process.env.MARKETPLACE_ANALYTICS_SEARCH_REPLICA_URLS ||
    '';
  const explicitUrls = uniqueStrings(String(rawUrls || '').split(','))
    .filter((url) => url !== marketplaceDatabaseUrl());
  if (explicitUrls.length > 0) return explicitUrls;
  const readReplicaUrls = configuredMarketplaceReadReplicaDatabaseUrls();
  return readReplicaUrls.length > 0 ? readReplicaUrls : [marketplaceDatabaseUrl()].filter(Boolean);
}

function marketplaceDimensionSearchDatabaseUrls() {
  const variationUrls = configuredMarketplaceVariationSearchDatabaseUrls();
  const readReplicaUrls = configuredMarketplaceReadReplicaDatabaseUrls();
  const fallbackUrl = marketplaceDatabaseUrl();
  const firstAvailable = (...urls) => uniqueStrings(urls).filter(Boolean)[0] || fallbackUrl;
  return {
    number: firstAvailable(
      process.env.MARKETPLACE_NUMBER_SEARCH_DATABASE_URL,
      process.env.MARKETPLACE_PEER2_DATABASE_URL,
      variationUrls[0],
      readReplicaUrls[0],
    ),
    expansion: firstAvailable(
      process.env.MARKETPLACE_EXPANSION_SEARCH_DATABASE_URL,
      process.env.MARKETPLACE_PEER1_DATABASE_URL,
      variationUrls[1],
      readReplicaUrls[1],
    ),
    rarity: firstAvailable(
      process.env.MARKETPLACE_RARITY_SEARCH_DATABASE_URL,
      process.env.MARKETPLACE_PEER3_DATABASE_URL,
      marketplaceNameSearchDatabaseUrl(),
      readReplicaUrls[2],
    ),
    variation_owner: firstAvailable(
      process.env.MARKETPLACE_VARIATION_OWNER_SEARCH_DATABASE_URL,
      process.env.MARKETPLACE_VARIATION_SEARCH_DATABASE_URL,
      variationUrls[0],
      process.env.MARKETPLACE_PEER2_DATABASE_URL,
      process.env.MARKETPLACE_PEER1_DATABASE_URL,
      readReplicaUrls[0],
    ),
  };
}

function marketplaceDimensionSearchRoute(dimension) {
  const cleanDimension = String(dimension || '').trim();
  const urls = marketplaceDimensionSearchDatabaseUrls();
  const selectedUrl = urls[cleanDimension] || marketplaceDatabaseUrl();
  return {
    dimension: cleanDimension,
    source: cleanDimension,
    configured: selectedUrl !== marketplaceDatabaseUrl(),
    fallbackToPrimary: selectedUrl === marketplaceDatabaseUrl(),
  };
}

function applicationName(label) {
  return String(label || 'vercel-marketplace')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'vercel-marketplace';
}

function createPool(
  connectionString,
  poolMaxEnv,
  label,
  sslVerifyEnv = 'MARKETPLACE_DATABASE_SSL_VERIFY',
  sslEnv = 'MARKETPLACE_DATABASE_SSL',
) {
  if (!connectionString) {
    const error = new Error('MARKETPLACE_DATABASE_URL is not configured.');
    error.statusCode = 500;
    throw error;
  }
  const sanitizedConnectionString =
    process.env[sslVerifyEnv] === '1'
      ? connectionString
      : connectionString.replace(/([?&])sslmode=[^&]+&?/i, (match, prefix) =>
          prefix === '?' && match.endsWith('&') ? '?' : prefix === '?' ? '' : '',
        ).replace(/[?&]$/, '');
  const createdPool = new Pool({
    connectionString: sanitizedConnectionString,
    max: Number(process.env[poolMaxEnv] || process.env.MARKETPLACE_DATABASE_POOL_MAX || 4),
    idleTimeoutMillis: Number(process.env.MARKETPLACE_DATABASE_IDLE_MS || 10_000),
    connectionTimeoutMillis: Number(process.env.MARKETPLACE_DATABASE_CONNECT_MS || 8_000),
    application_name: process.env.MARKETPLACE_DATABASE_APPLICATION_NAME || applicationName(label),
    ssl: process.env[sslEnv] === '0'
      ? false
      : { rejectUnauthorized: process.env[sslVerifyEnv] === '1' },
  });
  createdPool.on('connect', (client) => {
    client.query('set jit = off').catch((error) => {
      console.error(`Failed to disable ${label} database JIT`, error);
    });
  });
  return createdPool;
}

function ensureReadReplicaPools() {
  const connectionStrings = marketplaceAnalyticsSearchDatabaseUrls();
  if (
    connectionStrings.length === 1 &&
    connectionStrings[0] === marketplaceDatabaseUrl()
  ) {
    return [getMarketplacePool()];
  }
  const poolKey = connectionStrings.join('\n');
  if (readReplicaPoolKey !== poolKey) {
    readReplicaPools.forEach((existingPool) => {
      if (existingPool && existingPool !== pool && existingPool !== nameSearchPool) {
        existingPool.end().catch(() => {});
      }
    });
    readReplicaPools = connectionStrings.map((connectionString, index) =>
      createPool(
        connectionString,
        'MARKETPLACE_ANALYTICS_SEARCH_DATABASE_POOL_MAX',
        `vercel-searchbar-analytics-${index + 1}`,
      ));
    readReplicaPoolIndex = 0;
    readReplicaPoolKey = poolKey;
  }
  return readReplicaPools;
}

function getMarketplaceAnalyticsSearchPool() {
  const pools = ensureReadReplicaPools();
  const selectedPool = pools[readReplicaPoolIndex % pools.length];
  readReplicaPoolIndex = (readReplicaPoolIndex + 1) % pools.length;
  return selectedPool;
}

function getMarketplaceAssistantReadOnlyPool() {
  const connectionString = marketplaceAssistantReadOnlyDatabaseUrl();
  if (connectionString === marketplaceDatabaseUrl()) {
    return getMarketplacePool();
  }
  if (connectionString === marketplaceNameSearchDatabaseUrl()) {
    return getMarketplaceNameSearchPool();
  }
  if (!assistantReadOnlyPool) {
    assistantReadOnlyPool = createPool(
      connectionString,
      'POKO_ASSISTANT_READONLY_DATABASE_POOL_MAX',
      'poko-assistant-readonly',
    );
  }
  return assistantReadOnlyPool;
}

function getMarketplaceWriterPool() {
  const connectionString = marketplaceWriterDatabaseUrl();
  if (connectionString === marketplaceDatabaseUrl()) {
    return getMarketplacePool();
  }
  const poolKey = `${connectionString}\n${process.env.MARKETPLACE_WRITER_DATABASE_SSL || ''}`;
  if (writerPoolKey !== poolKey) {
    if (writerPool) {
      writerPool.end().catch(() => {});
    }
    writerPool = createPool(
      connectionString,
      'MARKETPLACE_WRITER_DATABASE_POOL_MAX',
      'marketplace-writer',
      'MARKETPLACE_WRITER_DATABASE_SSL_VERIFY',
      'MARKETPLACE_WRITER_DATABASE_SSL',
    );
    writerPoolKey = poolKey;
  }
  return writerPool;
}

function getMarketplacePool(game = currentGame()) {
  const normalized = normalizeGame(game);
  if (normalized === 'pokemon') {
    const connectionString = marketplaceDatabaseUrl();
    if (!pool) {
      pool = createPool(connectionString, 'MARKETPLACE_DATABASE_POOL_MAX', 'marketplace');
    }
    return pool;
  }
  if (!gamePools.has(normalized)) {
    const connectionString = databaseUrlForGame(normalized);
    if (!connectionString) {
      const error = new Error(`${normalized} marketplace database URL is not configured.`);
      error.statusCode = 500;
      throw error;
    }
    gamePools.set(
      normalized,
      createPool(
        connectionString,
        'MARKETPLACE_DATABASE_POOL_MAX',
        `marketplace-${normalized}`,
      ),
    );
  }
  return gamePools.get(normalized);
}

function getMarketplaceNameSearchPool() {
  const connectionString = marketplaceNameSearchDatabaseUrl();
  if (connectionString === marketplaceDatabaseUrl()) {
    return getMarketplacePool();
  }
  if (!nameSearchPool) {
    nameSearchPool = createPool(
      connectionString,
      'MARKETPLACE_NAME_SEARCH_DATABASE_POOL_MAX',
      'marketplace name-search',
    );
  }
  return nameSearchPool;
}

function getSupabaseNameIndexPool() {
  const connectionString = supabaseNameIndexDatabaseUrl();
  if (!connectionString) {
    const error = new Error('SUPABASE_NAME_INDEX_DATABASE_URL is not configured.');
    error.statusCode = 500;
    throw error;
  }
  if (!supabaseNameIndexPool) {
    supabaseNameIndexPool = createPool(
      connectionString,
      'SUPABASE_NAME_INDEX_DATABASE_POOL_MAX',
      'supabase name-index',
      'SUPABASE_NAME_INDEX_DATABASE_SSL_VERIFY',
    );
  }
  return supabaseNameIndexPool;
}

function getMarketplaceVariationSearchPool() {
  const connectionStrings = marketplaceVariationSearchDatabaseUrls();
  if (
    connectionStrings.length === 1 &&
    connectionStrings[0] === marketplaceDatabaseUrl()
  ) {
    return getMarketplacePool();
  }
  const poolKey = connectionStrings.join('\n');
  if (variationSearchPoolKey !== poolKey) {
    variationSearchPools.forEach((existingPool) => {
      if (existingPool && existingPool !== pool) {
        existingPool.end().catch(() => {});
      }
    });
    variationSearchPools = connectionStrings.map((connectionString, index) =>
      createPool(
        connectionString,
        'MARKETPLACE_VARIATION_SEARCH_DATABASE_POOL_MAX',
        `marketplace variation-search ${index + 1}`,
      ));
    variationSearchPoolIndex = 0;
    variationSearchPoolKey = poolKey;
  }
  const selectedPool = variationSearchPools[variationSearchPoolIndex % variationSearchPools.length];
  variationSearchPoolIndex = (variationSearchPoolIndex + 1) % variationSearchPools.length;
  return selectedPool;
}

function getMarketplaceVariationSearchPools() {
  const connectionStrings = marketplaceVariationSearchDatabaseUrls();
  if (
    connectionStrings.length === 1 &&
    connectionStrings[0] === marketplaceDatabaseUrl()
  ) {
    return [getMarketplacePool()];
  }
  const poolKey = connectionStrings.join('\n');
  if (variationSearchPoolKey !== poolKey) {
    variationSearchPools.forEach((existingPool) => {
      if (existingPool && existingPool !== pool) {
        existingPool.end().catch(() => {});
      }
    });
    variationSearchPools = connectionStrings.map((connectionString, index) =>
      createPool(
        connectionString,
        'MARKETPLACE_VARIATION_SEARCH_DATABASE_POOL_MAX',
        `marketplace variation-search ${index + 1}`,
      ));
    variationSearchPoolIndex = 0;
    variationSearchPoolKey = poolKey;
  }
  return variationSearchPools;
}

function ensureDimensionSearchPools() {
  const urls = marketplaceDimensionSearchDatabaseUrls();
  const poolKey = JSON.stringify(urls);
  if (dimensionSearchPoolKey !== poolKey) {
    dimensionSearchPools.forEach((existingPool) => {
      if (
        existingPool &&
        existingPool !== pool &&
        existingPool !== nameSearchPool &&
        existingPool !== supabaseNameIndexPool &&
        !readReplicaPools.includes(existingPool) &&
        !variationSearchPools.includes(existingPool)
      ) {
        existingPool.end().catch(() => {});
      }
    });
    dimensionSearchPools = new Map();
    dimensionSearchPoolKey = poolKey;
  }
  return urls;
}

function getMarketplaceDimensionSearchPool(dimension) {
  const urls = ensureDimensionSearchPools();
  const cleanDimension = String(dimension || '').trim();
  const connectionString = urls[cleanDimension] || marketplaceDatabaseUrl();
  if (connectionString === marketplaceDatabaseUrl()) {
    return getMarketplacePool();
  }
  if (connectionString === marketplaceNameSearchDatabaseUrl()) {
    return getMarketplaceNameSearchPool();
  }
  const variationUrls = marketplaceVariationSearchDatabaseUrls();
  const variationIndex = variationUrls.indexOf(connectionString);
  if (variationIndex >= 0) {
    return getMarketplaceVariationSearchPools()[variationIndex];
  }
  if (!dimensionSearchPools.has(cleanDimension)) {
    dimensionSearchPools.set(
      cleanDimension,
      createPool(
        connectionString,
        'MARKETPLACE_DIMENSION_SEARCH_DATABASE_POOL_MAX',
        `marketplace dimension-${cleanDimension}`,
      ),
    );
  }
  return dimensionSearchPools.get(cleanDimension);
}

function getMarketplacePrefixSearchClients() {
  const primaryUrl = marketplaceDatabaseUrl();
  const nameUrl = marketplaceNameSearchDatabaseUrl();
  const variationUrls = configuredMarketplaceVariationSearchDatabaseUrls();
  const clients = [];
  const usedUrls = new Set();
  function addClient(role, connectionString, poolGetter) {
    const url = String(connectionString || '').trim();
    if (!url || usedUrls.has(url)) return;
    usedUrls.add(url);
    clients.push({
      role,
      query: (text, values = []) => poolGetter().query(text, values),
    });
  }
  if (nameUrl !== primaryUrl) {
    addClient('name_search', nameUrl, getMarketplaceNameSearchPool);
  }
  const variationPools = variationUrls.length > 0 ? getMarketplaceVariationSearchPools() : [];
  variationUrls.forEach((url, index) => {
    addClient(
      index === 0 ? 'variation_search' : `variation_search_${index + 1}`,
      url,
      () => variationPools[index],
    );
  });
  if (clients.length === 0) {
    addClient('primary', primaryUrl, getMarketplacePool);
  }
  return clients;
}

async function marketplaceQuery(text, values = []) {
  return getMarketplacePool(currentGame()).query(text, values);
}

async function marketplaceWriteQuery(text, values = []) {
  return getMarketplaceWriterPool().query(text, values);
}

async function marketplaceNameSearchQuery(text, values = []) {
  return getMarketplaceNameSearchPool().query(text, values);
}

async function supabaseNameIndexQuery(text, values = []) {
  return getSupabaseNameIndexPool().query(text, values);
}

async function marketplaceVariationSearchQuery(text, values = []) {
  return getMarketplaceVariationSearchPool().query(text, values);
}

async function marketplaceAnalyticsSearchQuery(text, values = []) {
  return getMarketplaceAnalyticsSearchPool().query(text, values);
}

function assertReadOnlySql(text) {
  const sql = String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim();
  const error = new Error('Poko assistant database queries must be read-only.');
  error.statusCode = 500;
  if (!sql) {
    throw error;
  }
  if (!/^(select|with)\b/i.test(sql)) {
    throw error;
  }
  if (/;\s*\S/.test(sql)) {
    throw error;
  }
  if (/\b(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|copy|call|do|execute|refresh|vacuum|analyze|reindex|cluster|listen|notify|lock)\b/i.test(sql)) {
    throw error;
  }
}

async function marketplaceAssistantReadOnlyQuery(text, values = []) {
  assertReadOnlySql(text);
  return getMarketplaceAssistantReadOnlyPool().query(text, values);
}

async function marketplaceDimensionSearchQuery(dimension, text, values = []) {
  return getMarketplaceDimensionSearchPool(dimension).query(text, values);
}

module.exports = {
  getMarketplacePool,
  getMarketplaceWriterPool,
  getMarketplaceNameSearchPool,
  getSupabaseNameIndexPool,
  getMarketplaceVariationSearchPool,
  getMarketplaceAnalyticsSearchPool,
  getMarketplaceAssistantReadOnlyPool,
  marketplaceDatabaseUrl,
  marketplaceWriterDatabaseUrl,
  marketplaceAssistantReadOnlyDatabaseUrl,
  marketplaceAssistantReadOnlyConfigured,
  marketplaceNameSearchDatabaseUrl,
  supabaseNameIndexDatabaseUrl,
  supabaseNameIndexConfigured,
  marketplaceVariationSearchDatabaseUrls,
  marketplaceDimensionSearchDatabaseUrls,
  marketplaceDimensionSearchRoute,
  configuredMarketplaceVariationSearchDatabaseUrls,
  configuredMarketplaceReadReplicaDatabaseUrls,
  marketplaceAnalyticsSearchDatabaseUrls,
  marketplaceNameSearchQuery,
  supabaseNameIndexQuery,
  marketplaceQuery,
  marketplaceWriteQuery,
  marketplaceVariationSearchQuery,
  marketplaceAnalyticsSearchQuery,
  marketplaceAssistantReadOnlyQuery,
  assertReadOnlySql,
  marketplaceDimensionSearchQuery,
  getMarketplacePrefixSearchClients,
  getMarketplaceDimensionSearchPool,
  currentGame,
  isPokemonGame,
  normalizeGame,
  databaseUrlForGame,
};
