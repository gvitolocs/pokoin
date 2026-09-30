const { cleanToken, fetchMarketplaceProducts } = require('./_cardtrader_client');
const { marketplaceQuery } = require('./_marketplace_db');
const {
  publicSellerComment: publicFilteredSellerComment,
  isPromotionalSellerComment,
} = require('./_seller_comment_filter');

const PROVIDER = 'cardtrader';
const PKNRESERVE_SELLER_USERNAME = 'pknreserve';
const PKN_USDT_REFERENCE_PRICE = 0.005;
const CARDTRADER_MARKUP_PKN = 0; // market reference PKN matches dump (EUR/0.005); no shipping pad
const CARDTRADER_MARKETPLACE_PRODUCTS_PATH = '/api/v2/marketplace/products';
const MAX_EXPLICIT_LIMIT = 1000;
const CACHE_TTL_MS = 45_000;
const MAX_CACHE_ENTRIES = 100;
const SENSITIVE_METADATA_KEY = /(token|secret|password|authorization|credential|cookie|api[_-]?key|private[_-]?key|email|phone)/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const liveListingsCache = new Map();

function setCorsHeaders(res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

function cleanText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanNumericId(value) {
  const text = cleanText(value, 80);
  if (!/^[0-9]+$/.test(text)) return '';
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : '';
}

function cleanCardId(value) {
  const text = cleanText(value, 80);
  return /^[A-Za-z0-9:_-]+$/.test(text) ? text : '';
}

function cleanLanguage(value) {
  const text = cleanText(value, 16);
  return /^[A-Za-z0-9_-]{2,16}$/.test(text) ? text : '';
}

function cleanLimit(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(Math.trunc(number), 1), MAX_EXPLICIT_LIMIT);
}

function firstSearchValue(searchParams, names) {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value != null && String(value).trim()) return value;
  }
  return '';
}

function parseLiveListingsRequest(searchParams) {
  const blueprintInput = firstSearchValue(searchParams, [
    'blueprintId',
    'blueprint_id',
    'cardtraderBlueprintId',
    'cardtrader_blueprint_id',
    'id',
  ]);
  const cardInput = firstSearchValue(searchParams, ['cardId', 'card_id']);
  const blueprintId = blueprintInput ? cleanNumericId(blueprintInput) : '';
  const cardId = cardInput ? cleanCardId(cardInput) : '';

  if (blueprintInput && !blueprintId) {
    const error = new Error('Missing or invalid blueprintId.');
    error.statusCode = 400;
    throw error;
  }
  if (cardInput && !cardId) {
    const error = new Error('Missing or invalid cardId.');
    error.statusCode = 400;
    throw error;
  }
  if (!blueprintId && !cardId) {
    const error = new Error('Provide blueprintId or cardId.');
    error.statusCode = 400;
    throw error;
  }

  return {
    blueprintId,
    cardId,
    requestedId: blueprintId || cardId,
    requestedParam: blueprintId ? 'blueprintId' : 'cardId',
    language: cleanLanguage(searchParams.get('language') || searchParams.get('lang')),
    limit: cleanLimit(searchParams.get('limit')),
  };
}

function configuredCardTraderApiToken(env = process.env) {
  return cleanToken(env.CARDTRADER_AUTH_TOKEN || env.CARDTRADER_API_TOKEN || '');
}

function requireCardTraderApiToken(env = process.env) {
  const token = configuredCardTraderApiToken(env);
  if (!token) {
    const error = new Error(
      'Global CardTrader API token is not configured. Set CARDTRADER_AUTH_TOKEN or CARDTRADER_API_TOKEN.',
    );
    error.statusCode = 503;
    error.code = 'CARDTRADER_GLOBAL_API_TOKEN_MISSING';
    throw error;
  }
  return token;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.trunc(number) : null;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function booleanOrFalse(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
    if (['false', '0', 'no', 'n', ''].includes(lowered)) return false;
  }
  return false;
}

/** onepiece_language, lorcana_language, …: CardTrader names it per game. */
function gameLanguageProperty(properties = {}) {
  for (const [key, value] of Object.entries(properties || {})) {
    if (/_language$/.test(key) && cleanText(value, 40)) return value;
  }
  return '';
}

/**
 * The game of the running request, or 'pokemon' when the per-game helper is
 * not deployed next to this file (tests, older Pi releases).
 */
let marketplaceGames = null;
try {
  marketplaceGames = require('./_marketplace_game');
} catch (_) {
  marketplaceGames = null;
}

function requestGame() {
  try {
    return marketplaceGames ? marketplaceGames.normalizeGame(marketplaceGames.currentGame()) : 'pokemon';
  } catch (_) {
    return 'pokemon';
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value, 240);
    if (text) return text;
  }
  return '';
}

function isShippingModeLabel(value) {
  const normalized = cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return [
    'cardtrader zero',
    'ct zero',
    'zero',
    '1 day ready',
    'one day ready',
    'cardtrader 1 day ready',
    'normal',
  ].includes(normalized);
}

function publicSellerComment(product = {}) {
  const comment = firstText(
    product.seller_comment,
    product.sellerComment,
    product.seller_comments,
    product.sellerComments,
    product.description,
  );
  return isShippingModeLabel(comment) ? '' : publicFilteredSellerComment(comment);
}

function normalizeCondition(value) {
  const text = cleanText(value, 40);
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!normalized) return '';
  if (['nm', 'mint', 'near mint', 'near mint foil'].includes(normalized)) return 'NM';
  if (['sp', 'slightly played', 'lightly played', 'lp', 'excellent', 'ex'].includes(normalized)) return 'SP';
  if (['mp', 'moderately played', 'played good', 'good', 'gd'].includes(normalized)) return 'MP';
  if (['pl', 'played', 'poor played'].includes(normalized)) return 'PL';
  if (['poor', 'po', 'damaged', 'dmg'].includes(normalized)) return 'Poor';
  return text.toUpperCase() === text && text.length <= 5 ? text : text;
}

function normalizeLanguage(value) {
  const text = cleanText(value, 40);
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (lowered === 'english') return 'en';
  if (lowered === 'italian') return 'it';
  if (lowered === 'japanese') return 'ja';
  if (lowered === 'french') return 'fr';
  if (lowered === 'german') return 'de';
  if (lowered === 'spanish') return 'es';
  if (lowered === 'korean') return 'ko';
  if (lowered === 'chinese') return 'zh';
  return text;
}

function sanitizeMetadata(value, depth = 0) {
  if (value == null) return null;
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const cleanKey = cleanText(key, 120);
      if (!cleanKey || SENSITIVE_METADATA_KEY.test(cleanKey)) continue;
      output[cleanKey] = sanitizeMetadata(nestedValue, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string') return cleanText(value, 1000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function publicExpansion(product = {}) {
  const expansion = objectOrEmpty(product.expansion);
  return {
    id: integerOrNull(expansion.id ?? product.expansion_id),
    code: cleanText(expansion.code ?? product.expansion_code, 80),
    name: firstText(expansion.name_en, expansion.name, product.expansion),
  };
}

function normalizedPrice(product = {}) {
  const priceObject = objectOrEmpty(product.price);
  const priceCents = integerOrNull(product.price_cents ?? product.priceCents ?? priceObject.cents);
  const price = numberOrNull(product.price_amount ?? product.priceAmount ?? priceObject.amount) ??
    (priceCents == null ? null : priceCents / 100);
  return {
    price,
    priceCents,
    currency: cleanText(
      product.currency ?? product.price_currency ?? product.priceCurrency ?? priceObject.currency ?? '',
      12,
    ),
  };
}

function pknReferencePrice(env = process.env) {
  const referencePrice = Number(env.PKN_CHECKOUT_USDT_PRICE || PKN_USDT_REFERENCE_PRICE);
  return Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : PKN_USDT_REFERENCE_PRICE;
}

function cardTraderDisplayPricePkn(price, currency, env = process.env) {
  const amount = Number(price);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const normalizedCurrency = cleanText(currency || 'EUR', 12).toUpperCase();
  if (normalizedCurrency === 'PKN' || normalizedCurrency === 'POKOIN') {
    return amount;
  }
  return amount / pknReferencePrice(env);
}

function textIncludesOneDayReady(...values) {
  const text = values
    .map((value) => cleanText(value, 1000))
    .filter(Boolean)
    .join(' ');
  return /\b(?:1|one)[\s-]*day[\s-]*ready\b/i.test(text);
}

function shippingLabelForMode(mode) {
  if (mode === 'one_day_ready') return '1-Day Ready';
  if (mode === 'zero') return 'Zero';
  if (mode === 'normal') return 'Normal';
  return 'Unknown';
}

function inferCardTraderShippingMode(product = {}, user = objectOrEmpty(product.user || product.seller)) {
  const hasOneDayReadyText = textIncludesOneDayReady(
    user.username,
    user.name,
    user.display_name,
    user.public_name,
    product.seller_name,
    product.seller_display_name,
    product.name,
    product.name_en,
    product.description,
  );
  if (hasOneDayReadyText) {
    return 'one_day_ready';
  }

  const canSellViaHub = booleanOrFalse(user.can_sell_via_hub ?? product.can_sell_via_hub);
  const canSellSealedWithCtZero = booleanOrFalse(
    user.can_sell_sealed_with_ct_zero ?? product.can_sell_sealed_with_ct_zero,
  );
  if (canSellViaHub || canSellSealedWithCtZero) {
    return 'zero';
  }

  return product && typeof product === 'object' ? 'normal' : 'unknown';
}

function normalizeLiveListing(product = {}, fallbackBlueprintId = null) {
  const properties = objectOrEmpty(product.properties_hash || product.properties);
  const user = objectOrEmpty(product.user || product.seller);
  const buyerPrice = objectOrEmpty(product.buyer_price || product.buyerPrice);
  const sellerPrice = objectOrEmpty(product.seller_price || product.sellerPrice);
  const productId = cleanText(
    product.id ?? product.product_id ?? product.productId ?? product.listing_id ?? product.listingId,
    160,
  );
  const blueprintId = numberOrNull(product.blueprint_id ?? product.blueprintId ?? fallbackBlueprintId);
  const price = normalizedPrice(product);
  const shippingMode = inferCardTraderShippingMode(product, user);

  return {
    externalListingId: productId,
    externalProductId: productId,
    cardtraderProductId: productId,
    blueprintId: blueprintId == null ? null : String(blueprintId),
    cardtraderBlueprintId: blueprintId == null ? null : String(blueprintId),
    name: firstText(product.name_en, product.name, product.blueprint?.name),
    expansion: publicExpansion(product),
    price: price.price,
    priceCents: price.priceCents,
    currency: price.currency,
    displayPricePkn: cardTraderDisplayPricePkn(price.price, price.currency),
    markupPkn: CARDTRADER_MARKUP_PKN,
    buyerPrice: {
      priceCents: integerOrNull(buyerPrice.cents),
      currency: cleanText(buyerPrice.currency, 12),
      formatted: cleanText(product.formatted_price, 80),
    },
    sellerPrice: {
      priceCents: integerOrNull(sellerPrice.cents),
      currency: cleanText(sellerPrice.currency, 12),
    },
    quantity: Math.max(integerOrNull(product.quantity ?? product.qty) ?? 0, 0),
    condition: normalizeCondition(firstText(
      product.condition,
      product.state,
      properties.condition,
      properties.pokemon_condition,
    )),
    language: normalizeLanguage(firstText(
      product.language,
      product.lang,
      properties.language,
      properties.pokemon_language,
      properties.mtg_language,
      gameLanguageProperty(properties),
    )),
    description: cleanText(product.description, 1000),
    sellerComment: publicSellerComment(product, properties),
    properties: sanitizeMetadata(properties) || {},
    rawMetadata: sanitizeMetadata(product) || {},
    shippingMode,
    shippingLabel: shippingLabelForMode(shippingMode),
    seller: {
      accountId: cleanText(user.id ?? user.user_id ?? product.seller_id, 160),
      accountName: PKNRESERVE_SELLER_USERNAME,
      displayName: PKNRESERVE_SELLER_USERNAME,
      sourceAccountName: firstText(user.username, user.name, product.seller_name),
      country: cleanText(user.country_code ?? user.country ?? product.seller_country, 40),
      type: cleanText(user.user_type ?? product.seller_type, 80),
      canSellViaHub: booleanOrFalse(user.can_sell_via_hub ?? product.can_sell_via_hub),
      canSellSealedWithCtZero: booleanOrFalse(
        user.can_sell_sealed_with_ct_zero ?? product.can_sell_sealed_with_ct_zero,
      ),
      maxSellableIn24hQuantity: integerOrNull(
        user.max_sellable_in24h_quantity ?? product.max_sellable_in24h_quantity,
      ),
    },
    graded: product.graded == null ? null : Boolean(product.graded),
    onVacation: product.on_vacation == null ? null : Boolean(product.on_vacation),
    bundleSize: integerOrNull(product.bundle_size),
    source: {
      provider: PROVIDER,
      apiPath: CARDTRADER_MARKETPLACE_PRODUCTS_PATH,
      live: true,
      persisted: false,
    },
  };
}

function isEligiblePokoinCardTraderListing(listing = {}) {
  return listing.quantity > 0 &&
    listing.displayPricePkn != null &&
    (listing.shippingMode === 'zero' || listing.shippingMode === 'one_day_ready');
}

function listingsFromMarketplacePayload(payload, blueprintId, limit = null) {
  const cleanBlueprintId = cleanNumericId(blueprintId);
  let products = [];
  if (Array.isArray(payload)) {
    products = payload;
  } else {
    const grouped = objectOrEmpty(payload);
    products = Array.isArray(grouped[cleanBlueprintId])
      ? grouped[cleanBlueprintId]
      : Object.values(grouped).find(Array.isArray) || [];
  }
  const cleanListingLimit = cleanLimit(limit);
  const selectedProducts = cleanListingLimit == null ? products : products.slice(0, cleanListingLimit);
  return selectedProducts
    .map((product) => normalizeLiveListing(product, cleanBlueprintId))
    .filter(isEligiblePokoinCardTraderListing)
    .filter((listing) => listing.externalListingId);
}

async function resolveCardTraderBlueprintId(request, query = marketplaceQuery) {
  if (request.blueprintId) {
    return {
      cardtraderBlueprintId: request.blueprintId,
      pokoinCardId: request.cardId || '',
      mappingSource: 'direct_cardtrader_blueprint_id',
      warning: '',
    };
  }

  const numericCardId = cleanNumericId(request.cardId);
  if (!numericCardId) {
    const error = new Error('cardId must be a numeric Pokoin/CardTrader blueprint id for live CardTrader lookup.');
    error.statusCode = 400;
    throw error;
  }

  const game = cleanText(request.game, 40) || requestGame() || 'pokemon';
  {
    // Every game's catalog (Pokemon included) keys the Pokoin card_id to its
    // CardTrader blueprint in ct_id (card_id = 2 × ct_id). The blueprint join
    // below matched card_id itself: no offers, or another card's for the ids
    // that collide with a blueprint (6,219 Pokemon cards), and it does not
    // exist outside the Pokemon DB, so One Piece cards showed no listings.
    try {
      // The listings handler runs in the Pokemon DB context and passes the
      // game explicitly, so the catalog read switches to that game's DB.
      const read = () => query(
        'select card_id as pokoin_card_id, ct_id as cardtrader_blueprint_id from public.marketplace_search_candidates where card_id = $1::bigint limit 1',
        [numericCardId],
      );
      const result = marketplaceGames && typeof marketplaceGames.runWithGame === 'function'
        ? await marketplaceGames.runWithGame(game, read)
        : await read();
      const row = result.rows?.[0] || {};
      const cardtraderBlueprintId = cleanNumericId(row.cardtrader_blueprint_id);
      if (cardtraderBlueprintId) {
        return {
          cardtraderBlueprintId,
          pokoinCardId: cleanText(row.pokoin_card_id ?? numericCardId, 80),
          mappingSource: `${game}_catalog_ct_id`,
          warning: '',
        };
      }
    } catch (_) {
      // fall through to the shared lookup
    }
  }

  try {
    const result = await query(
      `
        select
          candidates.card_id as pokoin_card_id,
          blueprints.id as cardtrader_blueprint_id
        from (select $1::bigint as requested_id) input
        left join public.marketplace_search_candidates candidates
          on candidates.card_id = input.requested_id
        left join public.cardtrader_pokemon_blueprints blueprints
          on blueprints.id = coalesce(candidates.card_id, input.requested_id)
        limit 1
      `,
      [numericCardId],
    );
    const row = result.rows?.[0] || {};
    const cardtraderBlueprintId = cleanNumericId(row.cardtrader_blueprint_id ?? row.pokoin_card_id);
    if (cardtraderBlueprintId) {
      return {
        cardtraderBlueprintId,
        pokoinCardId: cleanText(row.pokoin_card_id ?? numericCardId, 80),
        mappingSource: 'oracle_card_data',
        warning: '',
      };
    }
  } catch (error) {
    return {
      cardtraderBlueprintId: numericCardId,
      pokoinCardId: numericCardId,
      mappingSource: 'numeric_card_id_fallback',
      warning: 'Oracle card mapping was unavailable; treated numeric cardId as a CardTrader blueprint id.',
    };
  }

  return {
    cardtraderBlueprintId: numericCardId,
    pokoinCardId: numericCardId,
    mappingSource: 'numeric_card_id_fallback',
    warning: 'No Oracle mapping row found; treated numeric cardId as a CardTrader blueprint id.',
  };
}

function cacheKeyForRequest(request, mapping) {
  return [
    PROVIDER,
    mapping.cardtraderBlueprintId,
    request.language || '',
    cleanLimit(request.limit) ?? 'all',
  ].join(':');
}

function pruneCache(nowMs) {
  for (const [key, entry] of liveListingsCache.entries()) {
    if (!entry || entry.expiresAtMs <= nowMs) liveListingsCache.delete(key);
  }
  while (liveListingsCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = liveListingsCache.keys().next().value;
    if (!oldestKey) break;
    liveListingsCache.delete(oldestKey);
  }
}

async function readLiveCardTraderListings(
  request,
  {
    env = process.env,
    fetchProducts = fetchMarketplaceProducts,
    query = marketplaceQuery,
    now = () => Date.now(),
  } = {},
) {
  const token = requireCardTraderApiToken(env);
  const mapping = await resolveCardTraderBlueprintId(request, query);
  const nowMs = now();
  pruneCache(nowMs);
  const cacheKey = cacheKeyForRequest(request, mapping);
  const cached = liveListingsCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return {
      ...cached.payload,
      cache: {
        ...cached.payload.cache,
        hit: true,
        expiresAt: new Date(cached.expiresAtMs).toISOString(),
      },
    };
  }

  const params = { blueprint_id: mapping.cardtraderBlueprintId };
  if (request.language) params.language = request.language;
  const payload = await fetchProducts(token, params);
  const listings = listingsFromMarketplacePayload(payload, mapping.cardtraderBlueprintId, request.limit);
  const expiresAtMs = nowMs + CACHE_TTL_MS;
  const responsePayload = {
    ok: true,
    provider: PROVIDER,
    source: 'live_cardtrader_marketplace_products',
    apiPath: CARDTRADER_MARKETPLACE_PRODUCTS_PATH,
    liveCardTraderApiUsed: true,
    persisted: false,
    fetchedAt: new Date(nowMs).toISOString(),
    requested: {
      id: request.requestedId,
      param: request.requestedParam,
      blueprintId: request.blueprintId || null,
      cardId: request.cardId || null,
      language: request.language || null,
      limit: request.limit ?? null,
    },
    mapping: {
      cardtraderBlueprintId: mapping.cardtraderBlueprintId,
      pokoinCardId: mapping.pokoinCardId || null,
      source: mapping.mappingSource,
      warning: mapping.warning || null,
    },
    cache: {
      hit: false,
      ttlSeconds: CACHE_TTL_MS / 1000,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    pagination: {
      limit: request.limit ?? null,
      limited: request.limit != null,
      returned: listings.length,
    },
    count: listings.length,
    listings,
  };
  liveListingsCache.set(cacheKey, { payload: responsePayload, expiresAtMs });
  pruneCache(nowMs);
  return responsePayload;
}

function clearLiveListingsCache() {
  liveListingsCache.clear();
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const url = new URL(req.url || '/', `https://${req.headers?.host || 'pokoin.com'}`);
    const request = parseLiveListingsRequest(url.searchParams);
    const payload = await readLiveCardTraderListings(request);
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('cardtrader-live-listings failed', {
      code: error.code || '',
      statusCode: error.statusCode || 500,
      message: error.message,
    });
    return res.status(error.statusCode || 500).json({
      error: error.message || 'CardTrader live listings lookup failed.',
      code: error.code,
    });
  }
};

module.exports.readLiveCardTraderListings = readLiveCardTraderListings;
module.exports.resolveCardTraderBlueprintId = resolveCardTraderBlueprintId;
module.exports.gameLanguageProperty = gameLanguageProperty;

module.exports._test = {
  clearLiveListingsCache,
  cardTraderDisplayPricePkn,
  CARDTRADER_MARKUP_PKN,
  cleanCardId,
  cleanLanguage,
  cleanLimit,
  cleanNumericId,
  MAX_EXPLICIT_LIMIT,
  configuredCardTraderApiToken,
  inferCardTraderShippingMode,
  isShippingModeLabel,
  isPromotionalSellerComment,
  isEligiblePokoinCardTraderListing,
  listingsFromMarketplacePayload,
  normalizeLiveListing,
  normalizeCondition,
  parseLiveListingsRequest,
  PKNRESERVE_SELLER_USERNAME,
  publicSellerComment,
  pknReferencePrice,
  readLiveCardTraderListings,
  requireCardTraderApiToken,
  resolveCardTraderBlueprintId,
  sanitizeMetadata,
  setCorsHeaders,
};
