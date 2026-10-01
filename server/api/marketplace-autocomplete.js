const {
  cleanLimit,
  cleanLanguage,
  cleanSearchTerm,
  rowsForSearchTerm,
  searchNameWithDatabase,
  searchNonNameWithDatabase,
} = require('./marketplace-search-candidates');
const { useMeiliSearchForLanguage } = require('./_marketplace_search_engine');
const { withCardEmojiFields } = require('./_marketplace_card_emoji');
const {
  getMarketplacePrefixSearchClients,
  marketplaceAnalyticsSearchQuery,
  marketplaceDatabaseUrl,
  marketplaceDimensionSearchQuery,
  marketplaceDimensionSearchRoute,
  marketplaceNameSearchDatabaseUrl,
  marketplaceNameSearchQuery,
  marketplaceQuery,
  marketplaceVariationSearchQuery,
  supabaseNameIndexConfigured,
  supabaseNameIndexQuery,
} = require('./_marketplace_db');
const { canonicalPathForRow } = require('./_marketplace_canonical_path');
const { normalizeMarketplaceRow } = require('./_marketplace_row');
const { authorizeSearchDebugRequest } = require('./_search_debug_auth');
const { requestHeader, verifyBearerToken } = require('./_firebase');
const {
  cleanSearchSessionId,
  isSearchSessionCancelled,
} = require('./_searchbar_session');

const HOT_PREVIEW_POOL_TTL_MS = 60_000;
const AUTOCOMPLETE_PREVIEW_ROW_LIMIT = 20;
const AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT = 500;
const AUTOCOMPLETE_CANDIDATE_ID_FLOOR = 500;
const AUTOCOMPLETE_SQL_SAFE_POOL_CAP = 5_000;
const SEARCH_CONTEXT_MAX_CARD_IDS = 10_000;
const SHORT_PREFIX_ANALYTICS_MAX_DEPTH = 1;
const SUPABASE_NAME_INDEX_MAX_DEPTH = 12;
const SUPABASE_VISIBLE_HYDRATION_LIMIT = 60;
const SUPABASE_PREDICTED_NAME_TOKEN_LIMIT = 20;
const SUPABASE_PREDICTED_NAME_SCAN_LIMIT = 240;
const SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT = 1000;
const SUPABASE_NAME_TOKEN_TABLE = 'marketplace_card_name_tokens';
const PREDICTIVE_DIMENSION_SOURCES = ['number', 'expansion', 'rarity', 'variation_owner'];
const FIRST_NAME_ANCHOR_MIN_CONFIDENCE = 60;
const MODIFIER_ONLY_ANCHOR_WORDS = new Set([
  'ex',
  'v',
  'vmax',
  'vstar',
  'gx',
  'lvx',
  'lv',
  'mega',
  'break',
  'radiant',
  'shining',
  'shiny',
  'prime',
  'tagteam',
]);
const CARD_NAME_ROOT_STOP_WORDS = new Set([
  ...MODIFIER_ONLY_ANCHOR_WORDS,
  'and',
  'gold',
  'star',
  'legend',
  'delta',
  'species',
]);
const hotPreviewPoolCaches = new WeakMap();
const prefixShardDisabledUntil = new Map();
let supabaseNameIndexDisabledUntil = 0;
const PREFIX_SHARD_SECONDARY_BUCKETS = [
  { kind: 'range', start: 'a', end: 'g' },
  { kind: 'range', start: 'h', end: 'o' },
  { kind: 'range', start: 'p', end: 'u' },
  { kind: 'range', start: 'v', end: 'z' },
  { kind: 'non_alpha' },
];
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function setCorsHeaders(res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

function compact(value) {
  return foldDiacritics(value)
    .replace(/\bheart\s*gold\s*&\s*soul\s*silver\b/gi, 'heartgoldsoulsilver')
    .replace(/\bheartgold\s*&\s*soulsilver\b/gi, 'heartgoldsoulsilver')
    .replace(/&/g, ' tagteam ')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function foldDiacritics(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function collectorNumberSql(candidateAlias = 'c', cardsAlias = 'mc', blueprintAlias = 'b') {
  const cleanVersion = (alias) => `
    nullif(
      case
        when ${alias}.version ~ '[0-9]' then regexp_replace(btrim(${alias}.version), '^#+\\s*', '')
        else ''
      end,
      ''
    )`;
  const cleanBlueprintValue = (expression) => `
    nullif(regexp_replace(btrim(coalesce(${expression}, '')), '^#+\\s*', ''), '')`;
  return `
    coalesce(
      nullif(${candidateAlias}.card_number, ''),
      ${cleanVersion(cardsAlias)},
      ${cleanVersion(blueprintAlias)},
      ${cleanBlueprintValue(`${blueprintAlias}.blueprint#>>'{fixed_properties,collector_number}'`)},
      ${cleanBlueprintValue(`${blueprintAlias}.blueprint->>'collector_number'`)},
      ${cleanBlueprintValue(`${blueprintAlias}.blueprint->>'number'`)},
      ${cleanBlueprintValue(`${blueprintAlias}.blueprint->>'card_number'`)},
      ''
    )`;
}

function collectorNumberJoinSql(
  candidateAlias = 'c',
  cardsAlias = 'mc',
  blueprintAlias = 'b',
  outputAlias = 'candidate_number',
) {
  return `
    left join public.marketplace_cards ${cardsAlias}
      on ${cardsAlias}.card_id = ${candidateAlias}.card_id
    left join public.cardtrader_pokemon_blueprints ${blueprintAlias}
      on ${blueprintAlias}.id = ${candidateAlias}.card_id
    left join lateral (
      select ${collectorNumberSql(candidateAlias, cardsAlias, blueprintAlias)} as card_number
    ) ${outputAlias} on true`;
}

function autocompleteCandidateIdRequestedLimit(searchTerm) {
  const depth = meaningfulSearchDepth(searchTerm);
  if (depth <= 1) return 0;
  if (depth === 2) return 5_000;
  if (depth === 3) return 2_500;
  if (depth === 4) return 1_250;
  return AUTOCOMPLETE_CANDIDATE_ID_FLOOR;
}

function autocompleteBackendPoolLimit(searchTerm) {
  const requestedLimit = autocompleteCandidateIdRequestedLimit(searchTerm);
  return requestedLimit > 0 ? requestedLimit : AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT;
}

function autocompleteCandidateIdAppliedLimit(searchTerm) {
  return Math.min(
    autocompleteBackendPoolLimit(searchTerm),
    AUTOCOMPLETE_SQL_SAFE_POOL_CAP,
  );
}

function autocompleteCandidateIdLadder(searchTerm) {
  return {
    depth: meaningfulSearchDepth(searchTerm),
    requestedLimit: autocompleteCandidateIdRequestedLimit(searchTerm),
    appliedLimit: autocompleteCandidateIdAppliedLimit(searchTerm),
    floor: AUTOCOMPLETE_CANDIDATE_ID_FLOOR,
    safeCap: AUTOCOMPLETE_SQL_SAFE_POOL_CAP,
  };
}

function shouldSkipAnalyticsForSearchTerm(searchTerm) {
  const depth = meaningfulSearchDepth(searchTerm);
  const maxDepth = Number(process.env.MARKETPLACE_SHORT_PREFIX_ANALYTICS_MAX_DEPTH);
  const configuredMaxDepth = Number.isFinite(maxDepth)
    ? Math.min(Math.max(Math.trunc(maxDepth), 0), 2)
    : SHORT_PREFIX_ANALYTICS_MAX_DEPTH;
  return depth > 0 && depth <= configuredMaxDepth;
}

function shouldAvoidPrimarySearchFallback(searchTerm) {
  const depth = meaningfulSearchDepth(searchTerm);
  return depth > 0 && depth <= 2;
}

function searchCancelState(req, sessionId) {
  const state = {
    sessionId: cleanSearchSessionId(sessionId),
    clientDisconnected: false,
  };
  if (req && typeof req.on === 'function') {
    req.on('aborted', () => {
      state.clientDisconnected = true;
    });
  }
  return state;
}

function isSearchCanceled(cancelState) {
  return Boolean(
    cancelState?.clientDisconnected ||
      isSearchSessionCancelled(cancelState?.sessionId),
  );
}

function canceledAutocompleteResponse(searchTerm, searchLanguage, cancelState) {
  return {
    rows: [],
    pool: {
      source: 'session_canceled',
      size: 0,
      limit: 0,
      strategy: 'session_canceled',
    },
    search_context: null,
    canceled: true,
    search_session_id: cancelState?.sessionId || '',
    debug: {
      searchTerm,
      searchLanguage,
      searchPath: 'session_canceled',
      canceled: true,
      cancelReason: cancelState?.clientDisconnected
        ? 'client_disconnected'
        : 'session_canceled',
    },
  };
}

function readQueryForAutocomplete(searchTerm, query = marketplaceQuery) {
  if (query !== marketplaceQuery) return query;
  const terms = searchTerms(searchTerm);
  const hasStructuredToken = terms.some((term) =>
    /^[0-9]+$/.test(term) ||
    isVariationIntentTerm(term) ||
    isRarityTerm(term) ||
    isExpansionAliasTerm(term));
  if (shouldAvoidPrimarySearchFallback(searchTerm) || !hasStructuredToken) {
    return marketplaceNameSearchQuery;
  }
  return marketplaceVariationSearchQuery;
}

function cleanContextCandidateIdLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return AUTOCOMPLETE_SQL_SAFE_POOL_CAP;
  return Math.min(
    Math.max(Math.trunc(limit), 0),
    SEARCH_CONTEXT_MAX_CARD_IDS,
  );
}

function nameSearchTimeoutMs() {
  const value = Number(process.env.MARKETPLACE_NAME_SEARCH_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 1500;
  return Math.min(Math.max(Math.trunc(value), 250), 5000);
}

function nameSearchCircuitMs() {
  const value = Number(process.env.MARKETPLACE_NAME_SEARCH_CIRCUIT_MS);
  if (!Number.isFinite(value)) return 60_000;
  return Math.min(Math.max(Math.trunc(value), 5_000), 300_000);
}

function dimensionSearchTimeoutMs() {
  const value = Number(process.env.MARKETPLACE_DIMENSION_SEARCH_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 1200;
  return Math.min(Math.max(Math.trunc(value), 250), 5000);
}

function supabaseNameIndexCircuitOpen() {
  return Date.now() < supabaseNameIndexDisabledUntil;
}

function disableSupabaseNameIndexTemporarily() {
  supabaseNameIndexDisabledUntil = Date.now() + nameSearchCircuitMs();
}

function resetSupabaseNameIndexCircuitForTest() {
  supabaseNameIndexDisabledUntil = 0;
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'MARKETPLACE_SEARCH_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function searchTerms(value) {
  const rawTerms = foldDiacritics(normalizeVariationPhrases(value))
    .toLowerCase()
    .replace(/\b([a-z0-9]+)s\b/g, "$1's")
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter(Boolean);
  return rawTerms.filter((term) =>
    term.length >= 2 ||
    term === 'v' ||
    term === 'n' ||
    ((term === 'g' || term === 'e') && rawTerms.length > 1));
}

function predictiveChunksForQuery(value, minLength = 2, maxLength = 3) {
  const compactValue = compact(normalizeVariationPhrases(value));
  if (compactValue.length < minLength) return [];
  const chunks = [];
  const seen = new Set();
  const cleanMaxLength = Math.min(Math.max(maxLength, minLength), 4);
  for (let length = minLength; length <= Math.min(cleanMaxLength, compactValue.length); length += 1) {
    for (let index = 0; index <= compactValue.length - length; index += 1) {
      const chunk = compactValue.slice(index, index + length);
      const key = `${chunk}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push({
        chunk,
        position: index + 1,
        length,
        isPrefix: index === 0,
      });
    }
  }
  return chunks
    .sort((left, right) =>
      (left.isPrefix === right.isPrefix ? 0 : left.isPrefix ? -1 : 1) ||
      right.length - left.length ||
      left.position - right.position ||
      left.chunk.localeCompare(right.chunk))
    .slice(0, 16);
}

function shouldTrySupabaseNameIndex(searchTerm, previousContext = null) {
  if (!supabaseNameIndexConfigured()) return false;
  if (supabaseNameIndexCircuitOpen()) return false;
  const depth = meaningfulSearchDepth(searchTerm);
  if (depth < 2 || depth > SUPABASE_NAME_INDEX_MAX_DEPTH) return false;
  const terms = searchTerms(searchTerm);
  const shortNamePrefix = terms.length === 0
    ? depth === 1
    : terms.length === 1 && !isRarityTerm(terms[0]);
  if (!shortNamePrefix) return false;
  if (!previousContext) return true;
  const previousStrategy = String(previousContext.strategy || '');
  const previousDepth = meaningfulSearchDepth(previousContext.query);
  return previousStrategy !== 'supabase_name_index' || previousDepth < depth;
}

function shouldTrySupabaseOneCharNameIndex(searchTerm) {
  if (!supabasePredictionConfigured()) return false;
  if (supabaseNameIndexCircuitOpen()) return false;
  return compact(searchTerm).length === 1;
}

function supabaseNameIndexDecision(searchTerm, previousContext = null) {
  const depth = meaningfulSearchDepth(searchTerm);
  const terms = searchTerms(searchTerm);
  const shortNamePrefix = terms.length === 0
    ? depth === 1
    : terms.length === 1 && !isRarityTerm(terms[0]);
  return {
    configured: supabaseNameIndexConfigured(),
    circuitOpen: supabaseNameIndexCircuitOpen(),
    depth,
    terms,
    shortNamePrefix,
    previousStrategy: previousContext?.strategy || null,
    previousDepth: previousContext ? meaningfulSearchDepth(previousContext.query) : null,
    shouldTry: shouldTrySupabaseNameIndex(searchTerm, previousContext),
  };
}

async function supabaseNameIndexCandidateRows(
  searchTerm,
  poolLimit,
  searchLanguage = 'en',
  query = supabaseNameIndexQuery,
) {
  const compactQuery = compact(searchTerm);
  if (!compactQuery) return [];
  const normalizedLanguage = cleanLanguage(searchLanguage);
  const result = await withTimeout(
    query(
      `
        with input as (
          select
            $1::text as compact_q,
            $2::text as language,
            least(greatest($3::integer, 1), 5000) as clean_limit
        ),
        matched_names as (
          select
            i.language,
            i.display_name,
            i.canonical_name,
            i.search_name,
            i.compact_name,
            i.name_tokens,
            i.card_ids,
            i.representative_labels,
            i.row_count,
            i.search_weight,
            i.updated_at,
            (
              case
                when i.compact_name = input.compact_q then 240000
                when public.marketplace_search_compact(i.search_name) = input.compact_q then 240000
                when i.compact_name like input.compact_q || '%' then 120000
                when public.marketplace_search_compact(i.search_name) like input.compact_q || '%' then 120000
                when input.compact_q = any(i.name_tokens) then 60000
                else 2500
              end +
              case
                when i.display_name = i.canonical_name then 100000
                else 0
              end +
              least(greatest(i.search_weight, 0), 5000)
            )::real as search_rank
          from input
          join public.marketplace_card_name_tokens i
            on i.language = input.language
            and (
              i.compact_name = input.compact_q
              or public.marketplace_search_compact(i.search_name) = input.compact_q
              or i.compact_name like input.compact_q || '%'
              or public.marketplace_search_compact(i.search_name) like input.compact_q || '%'
              or input.compact_q = any(i.name_tokens)
            )
          where input.compact_q <> ''
          order by
            search_rank desc,
            length(i.compact_name),
            i.display_name
          limit 80
        ),
        expanded as (
          select distinct on (card_id)
            card_id::text as card_id,
            display_name as name,
            ''::text as set_name,
            ''::text as card_number,
            ''::text as product_variant,
            ''::text as rarity,
            ''::text as card_type,
            'single'::text as item_kind,
            'card'::text as product_type,
            ''::text as trainer_name,
            canonical_name,
            null::text as image_url,
            null::text as cdn_image_url,
            null::text as preview_image_url,
            null::jsonb as card_palette,
            ''::text as emoji,
            updated_at as imported_at,
            (search_rank - (ordinality::real * 0.01))::real as search_rank
          from matched_names
          cross join lateral unnest(card_ids) with ordinality as cards(card_id, ordinality)
          order by card_id, search_rank desc, ordinality
        )
        select *
        from expanded
        order by search_rank desc, name, card_number
        limit (select clean_limit from input)
      `,
      [compactQuery, normalizedLanguage, Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP)],
    ),
    nameSearchTimeoutMs(),
    'supabase name-index search',
  );
  return expandSupabaseNameIndexRows(result.rows, poolLimit);
}

function expandSupabaseNameIndexRows(rows, limit = AUTOCOMPLETE_SQL_SAFE_POOL_CAP) {
  const expanded = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (row?.card_id) {
      const id = String(row.card_id);
      if (!seen.has(id)) {
        seen.add(id);
        expanded.push(row);
      }
      continue;
    }
    const ids = cardIdsFromNameTokenRow(row, limit);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      expanded.push({
        card_id: id,
        name: row.display_name || row.search_name || row.canonical_name || '',
        set_name: '',
        card_number: '',
        product_variant: '',
        rarity: '',
        card_type: '',
        item_kind: 'single',
        product_type: 'card',
        trainer_name: '',
        canonical_name: row.canonical_name || row.display_name || '',
        image_url: null,
        cdn_image_url: null,
        preview_image_url: null,
        card_palette: null,
        emoji: '',
        imported_at: row.updated_at,
        search_rank: Number(row.search_rank || 0) - expanded.length * 0.01,
      });
      if (expanded.length >= limit) return expanded;
    }
  }
  return expanded;
}

function supabaseRestNameIndexConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseRestHelpers() {
  return require('./_supabase');
}

function supabasePredictedNameConfidence(row, compactQuery) {
  const compactName = String(row.compact_name || '');
  const tokens = Array.isArray(row.name_tokens) ? row.name_tokens.map(compact) : [];
  if (!compactQuery) return 0;
  if (compactName === compactQuery || tokens.includes(compactQuery)) return 100;
  if (compactName.startsWith(compactQuery)) return Math.max(72, 96 - Math.max(0, compactName.length - compactQuery.length));
  if (tokens.some((token) => token.startsWith(compactQuery))) return 84;
  if (
    compactQuery.length >= 3 &&
    tokens.some((token) =>
      token.startsWith(compactQuery.slice(0, 2)) &&
      boundedDistance(token.slice(0, compactQuery.length), compactQuery, 1) <= 1)
  ) {
    return 76;
  }
  if (
    compactQuery.length >= 4 &&
    compactName.startsWith(compactQuery.slice(0, 2)) &&
    boundedDistance(compactName.slice(0, compactQuery.length), compactQuery, 2) <= 2
  ) {
    return 68;
  }
  return 0;
}

function predictionLanguage(row, fallbackLanguage) {
  return cleanLanguage(row.language || row.search_language || fallbackLanguage);
}

function predictionDisplayToken(row) {
  return String(row.canonical_name || row.name || row.display_name || '').trim();
}

function cardIdsFromNameTokenRow(row, limit = SEARCH_CONTEXT_MAX_CARD_IDS) {
  const ids = Array.isArray(row.card_ids)
    ? row.card_ids
    : Array.isArray(row.representative_card_ids)
      ? row.representative_card_ids
      : [row.card_id];
  const result = [];
  const seen = new Set();
  for (const rawId of ids || []) {
    const id = String(rawId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

function nameTokenPopularityCount(row) {
  const cardIdsCount = Array.isArray(row?.card_ids)
    ? row.card_ids.filter((id) => String(id || '').trim()).length
    : Array.isArray(row?.representative_card_ids)
      ? row.representative_card_ids.filter((id) => String(id || '').trim()).length
      : 0;
  const rowCount = Number(row?.row_count || 0);
  return Math.max(
    Number.isFinite(rowCount) ? rowCount : 0,
    cardIdsCount,
  );
}

function nameTokenIdsCount(row) {
  if (Array.isArray(row?.card_ids)) {
    return row.card_ids.filter((id) => String(id || '').trim()).length;
  }
  if (Array.isArray(row?.representative_card_ids)) {
    return row.representative_card_ids.filter((id) => String(id || '').trim()).length;
  }
  return String(row?.card_id || '').trim() ? 1 : 0;
}

function predictionCandidateCardIds(prediction, limit = 64) {
  const ids = Array.isArray(prediction?.candidate_card_ids)
    ? prediction.candidate_card_ids
    : Array.isArray(prediction?.candidateCardIds)
      ? prediction.candidateCardIds
      : Array.isArray(prediction?.representative_card_ids)
        ? prediction.representative_card_ids
        : [];
  const result = [];
  const seen = new Set();
  for (const rawId of ids || []) {
    const id = String(rawId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

function nameTokenPopularityBoost(row, compactQuery) {
  const count = nameTokenPopularityCount(row);
  if (count <= 0) return 0;
  const prefixLength = compact(compactQuery).length;
  const multiplier = prefixLength <= 1 ? 900 : prefixLength === 2 ? 320 : 80;
  return Math.min(count, 1000) * multiplier;
}

function nameTokenPopularityConfidenceBoost(row, compactQuery) {
  const count = nameTokenPopularityCount(row);
  if (count <= 1) return 0;
  const prefixLength = compact(compactQuery).length;
  if (prefixLength > 2) return 0;
  const maxBoost = prefixLength <= 1 ? 8 : 3;
  return Math.min(maxBoost, Math.log2(count + 1) * 1.2);
}

function comparePredictionTokenFamily(left, right) {
  const leftToken = String(left?.normalized || '');
  const rightToken = String(right?.normalized || '');
  if (!leftToken || !rightToken || leftToken === rightToken) return 0;
  if (
    rightToken.startsWith(leftToken) &&
    Number(left.confidence || 0) >= Number(right.confidence || 0)
  ) {
    return -1;
  }
  if (
    leftToken.startsWith(rightToken) &&
    Number(right.confidence || 0) >= Number(left.confidence || 0)
  ) {
    return 1;
  }
  return 0;
}

function representativeLabelsFromNameTokenRow(row, limit = 8) {
  const rawLabels = Array.isArray(row.representative_labels) ? row.representative_labels : [];
  const labels = [];
  const seen = new Set();
  for (const rawLabel of rawLabels) {
    if (!rawLabel || typeof rawLabel !== 'object') continue;
    const id = String(rawLabel.id || rawLabel.card_id || '').trim();
    const name = String(rawLabel.name || row.display_name || row.search_name || '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    labels.push({
      id,
      name,
      item_kind: String(rawLabel.item_kind || 'single'),
      product_type: String(rawLabel.product_type || 'card'),
      set_name: String(rawLabel.set_name || ''),
      card_number: String(rawLabel.card_number || ''),
      rarity: String(rawLabel.rarity || ''),
      product_variant: String(rawLabel.product_variant || ''),
      trainer_name: String(rawLabel.trainer_name || ''),
    });
    if (labels.length >= limit) break;
  }
  return labels;
}

function normalizePredictionRows(rows, compactQuery, searchLanguage, limit = SUPABASE_PREDICTED_NAME_TOKEN_LIMIT) {
  const byToken = new Map();
  const broadPrefix = compact(compactQuery).length <= 2;
  for (const row of rows || []) {
    const displayToken = predictionDisplayToken(row);
    const normalizedToken = compact(displayToken) || compact(row.compact_name);
    if (!displayToken || !normalizedToken) continue;
    const popularityCount = nameTokenPopularityCount(row);
    const confidence = Math.min(100, Math.max(
      Number(row.confidence || 0),
      supabasePredictedNameConfidence({
        compact_name: row.compact_name || normalizedToken,
        name_tokens: row.name_tokens,
      }, compactQuery),
    ) + nameTokenPopularityConfidenceBoost(row, compactQuery));
    if (confidence <= 0) continue;
    const searchRank = Number(row.search_rank ?? row.name_score ?? row.search_weight ?? 0);
    const popularityBoost = nameTokenPopularityBoost(row, compactQuery);
    const representativeCardIds = cardIdsFromNameTokenRow(row, 64);
    const idsCount = nameTokenIdsCount(row);
    const cardCount = Math.max(popularityCount, idsCount);
    const representativeLabels = representativeLabelsFromNameTokenRow(row, 8);
    const fallbackLabels = representativeLabels.length > 0
      ? representativeLabels
      : [{
          id: String(row.card_id || ''),
          name: String(row.display_name || row.name || displayToken),
          item_kind: String(row.item_kind || 'single'),
          product_type: String(row.product_type || 'card'),
          set_name: String(row.set_name || ''),
          card_number: String(row.card_number || ''),
          trainer_name: String(row.trainer_name || ''),
        }].filter((label) => label.id && label.name);
    const existing = byToken.get(normalizedToken);
    const next = {
      normalized: normalizedToken,
      normalized_token: normalizedToken,
      display: displayToken,
      display_token: displayToken,
      language: predictionLanguage(row, searchLanguage),
      confidence,
      score: Number(row.score || searchRank || confidence * 100) +
        popularityBoost,
      source_rank: 0,
      popularity_count: popularityCount,
      matched_prefix: compactQuery,
      ids_count: idsCount,
      card_count: cardCount,
      representative_card_ids: representativeCardIds,
      candidate_card_ids: representativeCardIds.slice(0, 32),
      representative_labels: fallbackLabels,
    };
    if (!existing) {
      byToken.set(normalizedToken, next);
    } else {
      existing.popularity_count += popularityCount;
      existing.ids_count += idsCount;
      existing.card_count = Math.max(existing.card_count, existing.popularity_count, existing.ids_count);
      existing.confidence = Math.min(
        100,
        Math.max(existing.confidence, next.confidence) +
          nameTokenPopularityConfidenceBoost(
            { row_count: existing.popularity_count },
            compactQuery,
          ),
      );
      existing.score = Math.max(existing.score, next.score) +
        nameTokenPopularityBoost(
          { row_count: existing.popularity_count },
          compactQuery,
        );
      existing.representative_card_ids = [...new Set([
        ...existing.representative_card_ids,
        ...representativeCardIds,
      ])].slice(0, 8);
      existing.candidate_card_ids = [...new Set([
        ...(existing.candidate_card_ids || []),
        ...representativeCardIds,
      ])].slice(0, 32);
      const labelIds = new Set(existing.representative_labels.map((label) => String(label.id)));
      for (const label of representativeLabels) {
        if (!labelIds.has(String(label.id))) {
          existing.representative_labels.push(label);
          labelIds.add(String(label.id));
        }
        if (existing.representative_labels.length >= 8) break;
      }
    }
  }
  return [...byToken.values()]
    .sort((left, right) =>
      comparePredictionTokenFamily(left, right) ||
      (broadPrefix
        ? right.score - left.score || right.confidence - left.confidence
        : right.confidence - left.confidence || right.score - left.score) ||
      left.display.localeCompare(right.display))
    .slice(0, limit)
    .map((entry, index) => {
      const { popularity_count, ...publicEntry } = entry;
      return { ...publicEntry, source_rank: index + 1 };
    });
}

function nameTokenSearchRank(row, compactQuery) {
  const compactName = String(row.compact_name || '');
  const tokens = Array.isArray(row.name_tokens) ? row.name_tokens.map(compact) : [];
  const base = compactName === compactQuery
    ? 240000
    : compactName.startsWith(compactQuery)
      ? 120000
      : tokens.includes(compactQuery)
        ? 60000
        : 2500;
  const baseDisplayBonus = String(row.display_name || '') === String(row.canonical_name || '')
    ? 100000
    : 0;
  const cappedWeight = Math.min(Math.max(Number(row.search_weight || 0), 0), 5000);
  return base + baseDisplayBonus + cappedWeight + nameTokenPopularityBoost(row, compactQuery);
}

function supabaseRestFuzzyNameTokenRows(rows, compactQuery) {
  const normalizedQuery = compact(compactQuery);
  if (!Array.isArray(rows) || normalizedQuery.length < 3) return rows || [];
  const maxDistance = normalizedQuery.length >= 6 ? 2 : 1;
  const prefix = normalizedQuery.slice(0, 2);
  return rows.filter((row) => {
    const candidates = [
      row?.compact_name,
      ...(Array.isArray(row?.name_tokens) ? row.name_tokens : []),
    ].map(compact).filter(Boolean);
    return candidates.some((candidate) => {
      if (!candidate.startsWith(prefix)) return false;
      if (Math.abs(candidate.length - normalizedQuery.length) > maxDistance + 1) return false;
      const candidatePrefix = candidate.slice(0, Math.min(candidate.length, normalizedQuery.length));
      return boundedDistance(candidatePrefix, normalizedQuery, maxDistance) <= maxDistance;
    });
  });
}

function expandNameTokenRowsToCandidateIds(rows, compactQuery, poolLimit) {
  const limit = Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
  const candidates = [];
  const seenIds = new Set();
  for (const row of rows || []) {
    const nameRank = Number(row.search_rank || row.score || nameTokenSearchRank(row, compactQuery));
    const cardIds = cardIdsFromNameTokenRow(row, limit);
    const representativeLabels = representativeLabelsFromNameTokenRow(row, 64);
    cardIds.forEach((cardId, index) => {
      if (seenIds.has(cardId) || candidates.length >= limit) return;
      seenIds.add(cardId);
      const label = representativeLabels.find((entry) => String(entry.id) === String(cardId));
      candidates.push({
        card_id: cardId,
        name: label?.name || row.display_name,
        canonical_name: row.canonical_name,
        display_name: row.display_name,
        search_name: row.search_name,
        language: row.language,
        set_name: label?.set_name || '',
        card_number: label?.card_number || '',
        product_variant: label?.product_variant || '',
        rarity: label?.rarity || '',
        card_type: '',
        item_kind: label?.item_kind || 'single',
        product_type: label?.product_type || 'card',
        trainer_name: label?.trainer_name || '',
        image_url: null,
        cdn_image_url: null,
        preview_image_url: null,
        card_palette: null,
        emoji: '',
        imported_at: row.updated_at,
        search_rank: nameRank - index * 0.01,
        predicted_name: {
          normalized: String(row.compact_name || ''),
          display: String(row.display_name || row.canonical_name || row.search_name || ''),
          score: nameRank,
          source_rank: 0,
          language: predictionLanguage(row, 'en'),
          representative_card_ids: cardIds.slice(0, 8),
        },
      });
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

function hydratedNameRankBonus(row, compactQuery) {
  const compactName = compact(row?.name || row?.display_name || row?.canonical_name || '');
  if (!compactName || !compactQuery) return 0;
  if (compactName === compactQuery) return 2000;
  if (compactName.startsWith(compactQuery)) return 900;
  return 0;
}

async function supabaseRestNameIndexCandidateRows(
  searchTerm,
  poolLimit,
  searchLanguage = 'en',
) {
  const compactQuery = compact(searchTerm);
  if (!compactQuery || !supabaseRestNameIndexConfigured()) return [];
  const { encodeFilterValue, supabaseFetch } = supabaseRestHelpers();
  const normalizedLanguage = cleanLanguage(searchLanguage);
  const cleanPoolLimit = Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
  const select = [
    'display_name',
    'canonical_name',
    'search_name',
    'language',
    'card_ids',
    'representative_labels',
    'row_count',
    'compact_name',
    'name_tokens',
    'search_weight',
    'updated_at',
  ].join(',');
  const rows = await supabaseFetch(
    `/rest/v1/${SUPABASE_NAME_TOKEN_TABLE}?select=${select}` +
      `&language=eq.${encodeFilterValue(normalizedLanguage)}` +
      `&or=(compact_name.eq.${encodeFilterValue(compactQuery)},compact_name.like.${encodeFilterValue(`${compactQuery}%`)},name_tokens.cs.${encodeFilterValue(`{"${compactQuery}"}`)})` +
      `&limit=80`,
    { serviceRole: true },
  );
  const fuzzyRows = Array.isArray(rows) && rows.length === 0 && compactQuery.length >= 3
    ? supabaseRestFuzzyNameTokenRows(
      await supabaseFetch(
        `/rest/v1/${SUPABASE_NAME_TOKEN_TABLE}?select=${select}` +
          `&language=eq.${encodeFilterValue(normalizedLanguage)}` +
          `&compact_name=like.${encodeFilterValue(`${compactQuery.slice(0, 2)}%`)}` +
          `&limit=80`,
        { serviceRole: true },
      ),
      compactQuery,
    )
    : rows;
  const candidates = Array.isArray(rows)
    ? expandNameTokenRowsToCandidateIds(fuzzyRows, compactQuery, cleanPoolLimit)
    : [];
  const bestByCardId = new Map();
  for (const row of candidates) {
    const key = String(row.card_id);
    const current = bestByCardId.get(key);
    if (!current || Number(row.search_rank || 0) > Number(current.search_rank || 0)) {
      bestByCardId.set(key, row);
    }
  }
  return [...bestByCardId.values()]
    .sort((left, right) =>
      Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
      String(left.name || '').localeCompare(String(right.name || '')) ||
      String(left.card_number || '').localeCompare(String(right.card_number || '')))
    .slice(0, cleanPoolLimit);
}

async function supabaseOneCharNameTokenRows(
  nameFragment,
  poolLimit,
  searchLanguage = 'en',
  query = supabaseNameIndexQuery,
) {
  const compactQuery = compact(nameFragment);
  if (compactQuery.length !== 1) return [];
  const normalizedLanguage = cleanLanguage(searchLanguage);
  const scanLimit = Math.min(
    Math.max(Math.trunc(Number(poolLimit) || 0) * 2, SUPABASE_PREDICTED_NAME_SCAN_LIMIT),
    SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT,
  );
  const result = await withTimeout(
    query(
      `
        with input as (
          select
            $1::text as compact_q,
            public.marketplace_search_normalize($1::text) as normalized_q,
            $2::text as language,
            least(greatest($3::integer, 20), 1000) as scan_limit
        ),
        matched as (
          select
            i.display_name,
            i.canonical_name,
            i.search_name,
            i.compact_name,
            i.normalized_name,
            i.name_tokens,
            i.language,
            i.card_ids,
            i.representative_labels,
            i.row_count,
            i.search_weight,
            i.updated_at,
            (
              case
                when i.compact_name = input.compact_q then 100
                when public.marketplace_search_compact(i.search_name) = input.compact_q then 100
                when i.compact_name like input.compact_q || '%' then greatest(72, 96 - greatest(length(i.compact_name) - length(input.compact_q), 0))
                when public.marketplace_search_compact(i.search_name) like input.compact_q || '%' then greatest(72, 96 - greatest(length(public.marketplace_search_compact(i.search_name)) - length(input.compact_q), 0))
                when i.normalized_name = input.normalized_q then 100
                when i.normalized_name like input.normalized_q || '%' then 88
                when exists (
                  select 1
                  from unnest(i.name_tokens) token
                  where public.marketplace_search_compact(token) like input.compact_q || '%'
                ) then 84
                else 0
              end
            )::real as confidence,
            (
              case
                when i.compact_name = input.compact_q then 240000
                when public.marketplace_search_compact(i.search_name) = input.compact_q then 240000
                when i.compact_name like input.compact_q || '%' then 120000
                when public.marketplace_search_compact(i.search_name) like input.compact_q || '%' then 120000
                when i.normalized_name = input.normalized_q then 90000
                when i.normalized_name like input.normalized_q || '%' then 70000
                when exists (
                  select 1
                  from unnest(i.name_tokens) token
                  where public.marketplace_search_compact(token) like input.compact_q || '%'
                ) then 60000
                else 0
              end +
              case when i.display_name = i.canonical_name then 800 else 0 end +
              least(greatest(i.search_weight, 0), 5000) +
              least(
                greatest(
                  greatest(
                    coalesce(i.row_count, 0),
                    coalesce(array_length(i.card_ids, 1), 0)
                  ),
                  0
                ),
                1000
              ) * 900
            )::real as score
          from input
          join public.marketplace_card_name_tokens i
            on i.language = input.language
            and (
              i.compact_name = input.compact_q
              or public.marketplace_search_compact(i.search_name) = input.compact_q
              or i.compact_name like input.compact_q || '%'
              or public.marketplace_search_compact(i.search_name) like input.compact_q || '%'
              or i.normalized_name = input.normalized_q
              or i.normalized_name like input.normalized_q || '%'
              or exists (
                select 1
                from unnest(i.name_tokens) token
                where public.marketplace_search_compact(token) like input.compact_q || '%'
              )
            )
          where input.compact_q <> ''
          order by score desc, confidence desc, length(i.compact_name), i.display_name
          limit (select scan_limit from input)
        )
        select *
        from matched
        where confidence > 0
        order by score desc, confidence desc, length(compact_name), display_name
      `,
      [compactQuery, normalizedLanguage, scanLimit],
    ),
    nameSearchTimeoutMs(),
    'supabase one-character name-token search',
  );
  return result.rows;
}

async function supabaseRestOneCharNameTokenRows(
  nameFragment,
  poolLimit,
  searchLanguage = 'en',
) {
  const compactQuery = compact(nameFragment);
  if (compactQuery.length !== 1 || !supabaseRestNameIndexConfigured()) return [];
  const normalizedLanguage = cleanLanguage(searchLanguage);
  const scanLimit = Math.min(
    Math.max(Math.trunc(Number(poolLimit) || 0) * 2, SUPABASE_PREDICTED_NAME_SCAN_LIMIT),
    SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT,
  );
  const { encodeFilterValue, supabaseFetch } = supabaseRestHelpers();
  const select = [
    'display_name',
    'canonical_name',
    'search_name',
    'language',
    'card_ids',
    'representative_labels',
    'row_count',
    'compact_name',
    'normalized_name',
    'name_tokens',
    'search_weight',
    'updated_at',
  ].join(',');
  const rows = await supabaseFetch(
    `/rest/v1/${SUPABASE_NAME_TOKEN_TABLE}?select=${select}` +
      `&language=eq.${encodeFilterValue(normalizedLanguage)}` +
      `&or=(compact_name.eq.${encodeFilterValue(compactQuery)},compact_name.like.${encodeFilterValue(`${compactQuery}%`)},normalized_name.eq.${encodeFilterValue(compactQuery)},normalized_name.like.${encodeFilterValue(`${compactQuery}%`)},normalized_name.like.${encodeFilterValue(`% ${compactQuery}%`)},name_tokens.cs.${encodeFilterValue(`{"${compactQuery}"}`)})` +
      `&limit=${scanLimit}`,
    { serviceRole: true },
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        confidence: supabasePredictedNameConfidence(row, compactQuery),
        score: nameTokenSearchRank(row, compactQuery),
      })).filter((row) => Number(row.confidence || 0) > 0)
    : [];
}

function oneCharPredictiveContext(predictions, source, durationMs) {
  return {
    strict: false,
    predicted_tokens: predictions.map((prediction) => ({
      ...predictionDebugEntry(prediction),
      source: 'supabase_one_char_name_index',
    })),
    sources: [
      {
        source: 'supabase_predicted_names',
        status: 'fulfilled',
        route: {
          source: 'supabase_predicted_names',
          configured: true,
          fallbackToPrimary: false,
        },
        row_count: predictions.length,
        source_kind: source,
        duration_ms: durationMs,
      },
    ],
  };
}

async function rowsFromSupabaseOneCharNameIndex(
  searchTerm,
  poolLimit,
  searchLanguage,
  debug,
  nameIndexQuery = supabaseNameIndexQuery,
) {
  const started = Date.now();
  const compactQuery = compact(searchTerm);
  if (compactQuery.length !== 1) return null;
  try {
    let source = 'postgres';
    let tokenRows;
    try {
      tokenRows = await supabaseOneCharNameTokenRows(
        searchTerm,
        poolLimit,
        searchLanguage,
        nameIndexQuery,
      );
    } catch (error) {
      if (!supabaseRestNameIndexConfigured()) throw error;
      source = 'rest_fallback';
      tokenRows = await supabaseRestOneCharNameTokenRows(searchTerm, poolLimit, searchLanguage);
      if (debug) {
        debug.supabaseOneCharNameIndexPostgresError = {
          reason: error.message || String(error),
          code: error.code,
        };
      }
    }
    if (!tokenRows.length) {
      if (debug) {
        debug.supabaseOneCharNameIndex = {
          used: true,
          fallback: true,
          source,
          reason: 'empty_candidate_pool',
          tokenRowCount: 0,
          candidateRowCount: 0,
          durationMs: Date.now() - started,
        };
      }
      return null;
    }
    const cleanPoolLimit = Math.min(
      Math.max(poolLimit, 1),
      AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT,
    );
    const predictions = normalizePredictionRows(
      tokenRows,
      compactQuery,
      searchLanguage,
      SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
    );
    const rows = expandNameTokenRowsToCandidateIds(tokenRows, compactQuery, cleanPoolLimit)
      .slice(0, cleanPoolLimit);
    const durationMs = Date.now() - started;
    rows.nonNameContext = {
      predictive_pool: oneCharPredictiveContext(predictions, source, durationMs),
    };
    if (debug) {
      debug.searchPath = 'supabase_one_char_name_index';
      debug.supabaseOneCharNameIndex = {
        used: true,
        fallback: false,
        source,
        compactFragment: compactQuery,
        tokenRowCount: tokenRows.length,
        candidateRowCount: rows.length,
        predictionCount: predictions.length,
        rowLimit: cleanPoolLimit,
        scanLimit: Math.min(
          Math.max(Math.trunc(Number(poolLimit) || 0) * 2, SUPABASE_PREDICTED_NAME_SCAN_LIMIT),
          SUPABASE_ONE_CHAR_NAME_SCAN_LIMIT,
        ),
        durationMs,
        predictions: predictions.map((prediction) => ({
          normalized: prediction.normalized,
          display: prediction.display,
          confidence: prediction.confidence,
          score: prediction.score,
          source_rank: prediction.source_rank,
          language: prediction.language,
          representative_card_ids: prediction.representative_card_ids,
        })),
      };
      debug.predictivePool = {
        strategy: 'supabase_one_char_name_index',
        model: 'supabase_one_char_name_tokens',
        predictedTokens: predictions,
        sources: [
          {
            source: 'supabase_predicted_names',
            status: 'fulfilled',
            rowCount: tokenRows.length,
            route: {
              source: 'supabase_predicted_names',
              configured: true,
              fallbackToPrimary: false,
            },
            durationMs,
          },
        ],
        failedSourceCount: 0,
        durationMs,
      };
      debug.tokenPlan = {
        strategy: 'supabase_one_char_name_index',
        source,
        compactFragment: compactQuery,
        tokenRowCount: tokenRows.length,
        candidateRowCount: rows.length,
        predictedTokenCount: predictions.length,
        durationMs,
      };
    }
    return rows;
  } catch (error) {
    disableSupabaseNameIndexTemporarily();
    if (debug) {
      debug.supabaseOneCharNameIndex = {
        used: false,
        fallback: true,
        reason: error.message || String(error),
        code: error.code,
        durationMs: Date.now() - started,
      };
    }
    return null;
  }
}

async function supabasePredictedNameTokens(
  nameFragment,
  searchLanguage = 'en',
  limit = SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
  query = supabaseNameIndexQuery,
) {
  const compactQuery = compact(nameFragment);
  if (!compactQuery) return [];
  const normalizedLanguage = cleanLanguage(searchLanguage);
  const cleanLimit = Math.min(Math.max(Math.trunc(Number(limit) || 0), 1), SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
  const scanLimit = Math.max(cleanLimit * 8, SUPABASE_PREDICTED_NAME_SCAN_LIMIT);
  const result = await withTimeout(
    query(
      `
        with input as (
          select
            $1::text as compact_q,
            $2::text as language,
            least(greatest($3::integer, 1), 20) as clean_limit,
            least(greatest($4::integer, 20), 500) as scan_limit
        ),
        matched as (
          select
            i.display_name,
            i.canonical_name,
            i.compact_name,
            i.name_tokens,
            i.language,
            i.search_name,
            i.card_ids,
            i.representative_labels,
            i.row_count,
            (
              case
                when i.compact_name = input.compact_q then 100
                when public.marketplace_search_compact(i.search_name) = input.compact_q then 100
                when i.compact_name like input.compact_q || '%' then greatest(72, 96 - greatest(length(i.compact_name) - length(input.compact_q), 0))
                when public.marketplace_search_compact(i.search_name) like input.compact_q || '%' then greatest(72, 96 - greatest(length(public.marketplace_search_compact(i.search_name)) - length(input.compact_q), 0))
                when input.compact_q = any(i.name_tokens) then 100
                when exists (
                  select 1
                  from unnest(i.name_tokens) token
                  where public.marketplace_search_compact(token) like input.compact_q || '%'
                ) then 84
                when length(input.compact_q) >= 3 and exists (
                  select 1
                  from unnest(i.name_tokens) token
                  where left(public.marketplace_search_compact(token), 2) = left(input.compact_q, 2)
                    and public.marketplace_edit_distance(
                      left(public.marketplace_search_compact(token), length(input.compact_q)),
                      input.compact_q
                    ) <= 1
                ) then 76
                else 0
              end
            )::real as confidence,
            (
              case
                when i.compact_name = input.compact_q then 240000
                when public.marketplace_search_compact(i.search_name) = input.compact_q then 240000
                when i.compact_name like input.compact_q || '%' then 120000
                when public.marketplace_search_compact(i.search_name) like input.compact_q || '%' then 120000
                when input.compact_q = any(i.name_tokens) then 60000
                else 2500
              end +
              case when i.display_name = i.canonical_name then 800 else 0 end +
              least(greatest(i.search_weight, 0), 5000) +
              least(
                greatest(
                  greatest(
                    coalesce(i.row_count, 0),
                    coalesce(array_length(i.card_ids, 1), 0)
                  ),
                  0
                ),
                1000
              ) *
                case
                  when length(input.compact_q) <= 1 then 900
                  when length(input.compact_q) = 2 then 320
                  else 80
                end
            )::real as score
          from input
          join public.marketplace_card_name_tokens i
            on i.language = input.language
            and (
              i.compact_name = input.compact_q
              or public.marketplace_search_compact(i.search_name) = input.compact_q
              or i.compact_name like input.compact_q || '%'
              or public.marketplace_search_compact(i.search_name) like input.compact_q || '%'
              or input.compact_q = any(i.name_tokens)
              or (
                length(input.compact_q) >= 3
                and exists (
                  select 1
                  from unnest(i.name_tokens) token
                  where left(public.marketplace_search_compact(token), 2) = left(input.compact_q, 2)
                    and public.marketplace_edit_distance(
                      left(public.marketplace_search_compact(token), length(input.compact_q)),
                      input.compact_q
                    ) <= 1
                )
              )
            )
          where input.compact_q <> ''
          order by score desc, length(i.compact_name), i.display_name
          limit (select scan_limit from input)
        )
        select
          canonical_name,
          display_name,
          compact_name,
          name_tokens,
          language,
          confidence,
          score,
          row_count,
          card_ids as representative_card_ids,
          representative_labels
        from matched
        where confidence > 0
        order by confidence desc, score desc, length(compact_name), canonical_name
        limit (select clean_limit from input)
      `,
      [compactQuery, normalizedLanguage, cleanLimit, scanLimit],
    ),
    nameSearchTimeoutMs(),
    'supabase predicted name tokens',
  );
  return normalizePredictionRows(result.rows, compactQuery, normalizedLanguage, cleanLimit);
}

async function supabaseRestPredictedNameTokens(
  nameFragment,
  searchLanguage = 'en',
  limit = SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
) {
  const compactQuery = compact(nameFragment);
  if (!compactQuery || !supabaseRestNameIndexConfigured()) return [];
  const normalizedLanguage = cleanLanguage(searchLanguage);
  const cleanLimit = Math.min(Math.max(Math.trunc(Number(limit) || 0), 1), SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
  const scanLimit = Math.max(cleanLimit * 8, SUPABASE_PREDICTED_NAME_SCAN_LIMIT);
  const { encodeFilterValue, supabaseFetch } = supabaseRestHelpers();
  const select = [
    'display_name',
    'canonical_name',
    'language',
    'search_name',
    'card_ids',
    'representative_labels',
    'row_count',
    'compact_name',
    'name_tokens',
    'search_weight',
  ].join(',');
  const rows = await supabaseFetch(
    `/rest/v1/${SUPABASE_NAME_TOKEN_TABLE}?select=${select}` +
      `&language=eq.${encodeFilterValue(normalizedLanguage)}` +
      `&or=(compact_name.eq.${encodeFilterValue(compactQuery)},compact_name.like.${encodeFilterValue(`${compactQuery}%`)},name_tokens.cs.${encodeFilterValue(`{"${compactQuery}"}`)})` +
      `&limit=${scanLimit}`,
    { serviceRole: true },
  );
  const fuzzyRows = Array.isArray(rows) && rows.length === 0 && compactQuery.length >= 3
    ? supabaseRestFuzzyNameTokenRows(
      await supabaseFetch(
        `/rest/v1/${SUPABASE_NAME_TOKEN_TABLE}?select=${select}` +
          `&language=eq.${encodeFilterValue(normalizedLanguage)}` +
          `&compact_name=like.${encodeFilterValue(`${compactQuery.slice(0, 2)}%`)}` +
          `&limit=${scanLimit}`,
        { serviceRole: true },
      ),
      compactQuery,
    )
    : rows;
  const candidateRows = Array.isArray(fuzzyRows)
    ? fuzzyRows.map((row) => ({
        ...row,
        score: nameTokenSearchRank(row, compactQuery),
      }))
    : [];
  return normalizePredictionRows(candidateRows, compactQuery, normalizedLanguage, cleanLimit);
}

async function predictedNameTokensFromSupabase(
  nameFragment,
  searchLanguage,
  debug,
  nameIndexQuery = supabaseNameIndexQuery,
  options = {},
) {
  const started = Date.now();
  const compactQuery = compact(nameFragment);
  if (!compactQuery) return [];
  try {
    let source = 'postgres';
    let predictions;
    try {
      predictions = await supabasePredictedNameTokens(
        nameFragment,
        searchLanguage,
        SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
        nameIndexQuery,
      );
    } catch (error) {
      if (!supabaseRestNameIndexConfigured()) throw error;
      source = 'rest_fallback';
      predictions = await supabaseRestPredictedNameTokens(
        nameFragment,
        searchLanguage,
        SUPABASE_PREDICTED_NAME_TOKEN_LIMIT,
      );
      if (debug) {
        debug.supabasePredictedNamePostgresError = {
          reason: error.message || String(error),
          code: error.code,
        };
      }
    }
    if (debug) {
      debug.supabasePredictedNames = {
        used: true,
        source,
        nameFragment,
        compactFragment: compactQuery,
        predictionCount: predictions.length,
        durationMs: Date.now() - started,
        predictions: predictions.map((prediction) => ({
          normalized: prediction.normalized,
          display: prediction.display,
          confidence: prediction.confidence,
          score: prediction.score,
          source_rank: prediction.source_rank,
          language: prediction.language,
          representative_card_ids: prediction.representative_card_ids,
        })),
      };
    }
    if (predictions.length === 0 && options.strict) {
      const error = new Error('Supabase predicted name token search returned no candidates.');
      error.code = 'SUPABASE_PREDICTED_NAMES_EMPTY';
      throw error;
    }
    return predictions;
  } catch (error) {
    disableSupabaseNameIndexTemporarily();
    if (debug) {
      debug.supabasePredictedNames = {
        used: false,
        fallback: !options.strict,
        reason: error.message || String(error),
        code: error.code,
        durationMs: Date.now() - started,
      };
    }
    if (options.strict) throw error;
    return [];
  }
}

async function rowsFromSupabaseNameIndex(
  searchTerm,
  poolLimit,
  searchLanguage,
  debug,
  hydrateQuery,
  nameIndexQuery = supabaseNameIndexQuery,
  options = {},
) {
  const supabaseStarted = Date.now();
  try {
    let source = 'postgres';
    let supabaseRows;
    try {
      supabaseRows = await supabaseNameIndexCandidateRows(
        searchTerm,
        poolLimit,
        searchLanguage,
        nameIndexQuery,
      );
    } catch (error) {
      if (!supabaseRestNameIndexConfigured()) throw error;
      source = 'rest_fallback';
      supabaseRows = await supabaseRestNameIndexCandidateRows(
        searchTerm,
        poolLimit,
        searchLanguage,
      );
      if (debug) {
        debug.supabaseNameIndexPostgresError = {
          reason: error.message || String(error),
          code: error.code,
        };
      }
    }
    if (supabaseRows.length === 0) {
      if (options.strict) {
        const error = new Error('Supabase name index returned no candidates.');
        error.code = 'SUPABASE_NAME_INDEX_EMPTY';
        throw error;
      }
      if (debug) {
        debug.supabaseNameIndex = {
          used: true,
          fallback: true,
          reason: 'empty_candidate_pool',
          source,
          candidateRowCount: 0,
          durationMs: Date.now() - supabaseStarted,
        };
      }
      return null;
    }
    const visibleHydrationLimit = Math.min(
      supabaseRows.length <= AUTOCOMPLETE_CANDIDATE_ID_FLOOR
        ? AUTOCOMPLETE_CANDIDATE_ID_FLOOR
        : Math.max(AUTOCOMPLETE_PREVIEW_ROW_LIMIT * 3, AUTOCOMPLETE_PREVIEW_ROW_LIMIT),
      supabaseRows.length <= AUTOCOMPLETE_CANDIDATE_ID_FLOOR
        ? AUTOCOMPLETE_CANDIDATE_ID_FLOOR
        : SUPABASE_VISIBLE_HYDRATION_LIMIT,
      supabaseRows.length,
    );
    const hydratedRows = await searchCandidatesForCardIdsWithDatabase(
      supabaseRows.slice(0, visibleHydrationLimit).map((row) => row.card_id),
      hydrateQuery,
    );
    const rankById = new Map(supabaseRows.map((row) => [
      String(row.card_id),
      Number(row.search_rank || 0),
    ]));
    const rowsById = new Map(hydratedRows.map((row) => [String(row.card_id), row]));
    const rows = supabaseRows
      .map((row) => {
        const hydrated = rowsById.get(String(row.card_id));
        const baseRank = Number(row.search_rank || 0);
        return hydrated
          ? {
              ...hydrated,
              search_rank: Math.max(
                Number(hydrated.search_rank || 0),
                baseRank + hydratedNameRankBonus(hydrated, compact(searchTerm)),
              ),
            }
          : row;
      })
      .sort((left, right) =>
        Number(right.search_rank || rankById.get(String(right.card_id)) || 0) -
          Number(left.search_rank || rankById.get(String(left.card_id)) || 0));
    if (debug) {
      debug.searchPath = 'supabase_name_index';
      debug.supabaseNameIndex = {
        used: true,
        fallback: false,
        source,
        candidateRowCount: supabaseRows.length,
        hydratedRowCount: hydratedRows.length,
        visibleHydrationLimit,
        durationMs: Date.now() - supabaseStarted,
      };
      debug.tokenPlan = {
        strategy: 'supabase_name_index',
        source,
        candidateRowCount: supabaseRows.length,
        hydratedRowCount: hydratedRows.length,
        visibleHydrationLimit,
        durationMs: Date.now() - supabaseStarted,
      };
    }
    return rows.slice(0, poolLimit);
  } catch (error) {
    disableSupabaseNameIndexTemporarily();
    if (options.strict) {
      throw error;
    }
    if (debug) {
      debug.supabaseNameIndex = {
        used: false,
        fallback: true,
        reason: error.message || String(error),
        code: error.code,
        durationMs: Date.now() - supabaseStarted,
      };
    }
    return null;
  }
}

function shouldPreferDirectNamePrefix(searchTerm) {
  const terms = searchTerms(searchTerm);
  if (terms.length !== 1) return false;
  const term = terms[0];
  if (/^[0-9]+$/.test(term) || isVariationIntentTerm(term) || isRarityTerm(term) || isExpansionAliasTerm(term)) {
    return false;
  }
  return compact(searchTerm) === compact(term);
}

function normalizeVariationPhrases(value) {
  return String(value || '')
    .replace(/\bheart\s*gold\s*&\s*soul\s*silver\b/gi, 'heartgoldsoulsilver')
    .replace(/\bheartgold\s*&\s*soulsilver\b/gi, 'heartgoldsoulsilver')
    .replace(/&/g, ' tagteam ')
    .replace(/\bhearth\s+gold\b/gi, 'heartgold')
    .replace(/\bheart\s+gold\b/gi, 'heartgold')
    .replace(/\blv\s*\.?\s*x\b/gi, 'lvx')
    .replace(/\blevel\s+x\b/gi, 'lvx')
    .replace(/\bv\s*max\b/gi, 'vmax')
    .replace(/\bv\s*star\b/gi, 'vstar')
    .replace(/\bg\s*x\b/gi, 'gx')
    .replace(/\be\s*x\b/gi, 'ex');
}

function isVariationTerm(term) {
  return new Set([
    'ex',
    'v',
    'vmax',
    'vstar',
    'gx',
    'lvx',
    'lv',
    'mega',
    'break',
    'radiant',
    'shining',
    'shiny',
    'prime',
    'tagteam',
  ]).has(compact(term));
}

function variationTermTargets(term) {
  const normalizedTerm = compact(term);
  if (!normalizedTerm) return [];
  if (isVariationTerm(normalizedTerm)) return [normalizedTerm];
  return [
    'ex',
    'v',
    'vmax',
    'vstar',
    'gx',
    'lvx',
    'lv',
    'mega',
    'break',
    'radiant',
    'shining',
    'shiny',
    'prime',
    'tagteam',
  ].filter((variation) => variation.startsWith(normalizedTerm));
}

function isVariationIntentTerm(term) {
  const normalizedTerm = compact(term);
  if (!normalizedTerm) return false;
  return isVariationTerm(normalizedTerm) ||
    normalizedTerm === 'g' ||
    normalizedTerm === 'e' ||
    (normalizedTerm.length >= 2 && variationTermTargets(normalizedTerm).length > 0);
}

function rowHasVariation(row, term) {
  const normalizedTerm = compact(term);
  const text = [
    row.name,
    row.rarity,
    row.card_type,
    row.product_type,
    row.product_variant,
  ].join(' ').toLowerCase();
  if (normalizedTerm === 'lvx') {
    return /(^|[^a-z0-9])(lv\.?x|level x)([^a-z0-9]|$)/.test(text);
  }
  if (normalizedTerm === 'lv') {
    return /(^|[^a-z0-9])lv\.?([0-9]+|x)([^a-z0-9]|$)/.test(text);
  }
  if (normalizedTerm === 'v') {
    return /(^|[^a-z0-9])v([^a-z0-9]|$)/.test(text);
  }
  if (normalizedTerm === 'mega') {
    return /(^|[^a-z0-9])(mega|m)([^a-z0-9]|$)/.test(text);
  }
  if (normalizedTerm === 'tagteam') {
    return /(^|[^a-z0-9])(tag\s*team|tagteam|&)([^a-z0-9]|$)/.test(text);
  }
  return new RegExp(`(^|[^a-z0-9])${normalizedTerm}([^a-z0-9]|$)`).test(text);
}

function rowHasVariationIntent(row, term) {
  return variationTermTargets(term).some((target) => rowHasVariation(row, target));
}

function rowHasSetToken(row, term) {
  const normalizedTerm = compact(term);
  if (!normalizedTerm) return false;
  const set = String(row.set_name || '').toLowerCase();
  return new RegExp(`(^|[^a-z0-9])${normalizedTerm}([^a-z0-9]|$)`).test(set);
}

function isRarityTerm(term) {
  return new Set([
    'sir',
    'ir',
    'ur',
    'sr',
    'rare',
    'ultra',
    'secret',
    'ill',
    'illus',
    'illustration',
    'holo',
    'shiny',
  ]).has(compact(term));
}

function rowHasRarity(row, term) {
  const normalizedTerm = compact(term);
  const text = [row.card_number, row.rarity].join(' ').toLowerCase();
  const normalizedText = text.replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalizedTerm === 'sir') {
    return normalizedText.includes('special illustration rare');
  }
  if (normalizedTerm === 'ir') {
    return normalizedText.includes('illustration rare');
  }
  if (normalizedTerm === 'ill' || normalizedTerm === 'illus' || normalizedTerm === 'illustration') {
    return normalizedText.includes('illustration rare');
  }
  if (normalizedTerm === 'ur' || normalizedTerm === 'ultra') {
    return normalizedText.includes('ultra rare');
  }
  if (normalizedTerm === 'sr' || normalizedTerm === 'secret') {
    return normalizedText.includes('secret rare');
  }
  return normalizedText.includes(normalizedTerm);
}

const expansionAliases = new Map([
  ['col', ['calloflegends']],
  ['calllegends', ['calloflegends']],
  ['calloflegends', ['calloflegends']],
  ['hgss', ['heartgoldsoulsilver', 'unleashed', 'undaunted', 'triumphant', 'calloflegends']],
  ['hgs', ['heartgoldsoulsilver', 'unleashed', 'undaunted', 'triumphant', 'calloflegends']],
  ['heartgold', ['heartgoldsoulsilver', 'heartgoldcollection', 'unleashed', 'undaunted', 'triumphant', 'calloflegends']],
  ['hearthgold', ['heartgoldsoulsilver', 'heartgoldcollection', 'unleashed', 'undaunted', 'triumphant', 'calloflegends']],
  ['soulsilver', ['heartgoldsoulsilver', 'soulsilvercollection', 'unleashed', 'undaunted', 'triumphant', 'calloflegends']],
  ['heartgoldsoulsilver', ['heartgoldsoulsilver', 'unleashed', 'undaunted', 'triumphant', 'calloflegends']],
  ['unleashed', ['unleashed']],
  ['undaunted', ['undaunted']],
  ['triumphant', ['triumphant']],
  ['151', ['151', 'pokemoncard151', 'collect151']],
  ['pokemon151', ['pokemoncard151']],
  ['pokemoncard151', ['pokemoncard151']],
  ['collect151', ['collect151']],
  ['cel', ['celebrations']],
  ['pal', ['paldeaevolved']],
  ['obf', ['obsidianflames']],
  ['obs', ['obsidianflames']],
  ['svi', ['scarletviolet']],
  ['sv', ['scarletviolet']],
]);

function expansionAliasTargets(term) {
  return expansionAliases.get(compact(term)) || [];
}

function isExpansionAliasTerm(term) {
  return expansionAliasTargets(term).length > 0;
}

function rowHasExpansionAlias(row, term) {
  const compactSet = compact(row.set_name || row.set || '');
  return expansionAliasTargets(term).some((target) =>
    compactSet === target || compactSet.startsWith(target) || target.startsWith(compactSet));
}

function genericEnergyExpansionPlan(query) {
  const tokens = searchTerms(query).map((term) => ({ term, kind: tokenKind(term) }));
  const expansionTokens = tokens.filter((token) => token.kind === 'expansion');
  const textTokens = tokens.filter((token) => token.kind === 'text');
  if (expansionTokens.length === 0 || !textTokens.some((token) => compact(token.term) === 'energy')) {
    return null;
  }
  const nonGenericTextTokens = textTokens.filter((token) =>
    !new Set(['basic', 'energy']).has(compact(token.term)));
  if (nonGenericTextTokens.length > 0) {
    return null;
  }
  return {
    strategy: 'generic_energy_expansion',
    tokens,
    expansionTokens,
  };
}

function isEnergyCardName(row) {
  const words = searchTerms(row?.canonical_name || row?.name || '');
  return words.length > 0 && compact(words[words.length - 1]) === 'energy';
}

function rowMatchesAnyExpansionToken(row, expansionTokens) {
  return (expansionTokens || []).some((token) => rowHasExpansionAlias(row, token.term));
}

function poolSearchTerm(value) {
  return cleanSearchTerm(normalizeVariationPhrases(value));
}

function isPokemonIdentityRow(row) {
  if (String(row.item_kind || '') === 'product') {
    return false;
  }
  const type = String(row.card_type || '').toLowerCase();
  if (!type || type === 'card') {
    return false;
  }
  return !/\b(trainer|supporter|item|stadium|energy|accessory|product|sealed)\b/.test(type);
}

function isLikelyNameTokenTypo(nameWords, term) {
  const normalizedTerm = compact(term);
  if (normalizedTerm.length < 3) {
    return false;
  }
  return nameWords.some((word) => {
    const normalizedWord = compact(word);
    if (normalizedWord.length < 3) {
      return false;
    }
    if (normalizedWord.startsWith(normalizedTerm) || normalizedTerm.startsWith(normalizedWord)) {
      return true;
    }
    return boundedDistance(normalizedWord, normalizedTerm, normalizedTerm.length <= 4 ? 1 : 2) <=
      (normalizedTerm.length <= 4 ? 1 : 2);
  });
}

function nameTokenConfidence(name, nameWords, term) {
  const compactNameValue = compact(name);
  const compactTerm = compact(term);
  if (!compactTerm) return 0;
  if (name === term || compactNameValue === compactTerm) return 100;
  if (name.startsWith(term) || compactNameValue.startsWith(compactTerm)) return 90;
  if (nameWords.some((word) => word.startsWith(term))) return 82;
  if (isLikelyNameTokenTypo(nameWords, term)) return 76;
  if (
    compactTerm.length >= 5 &&
    compactNameValue.startsWith(compactTerm.slice(0, 2)) &&
    boundedDistance(compactNameValue, compactTerm, 3) <= 3
  ) {
    return 64;
  }
  if (name.includes(term) || (compactTerm.length >= 4 && compactNameValue.includes(compactTerm))) return 60;
  return 0;
}

function confidentNameTokenSet(name, nameWords, terms) {
  const candidates = terms
    .filter((term) =>
      !/^[0-9]+$/.test(term) &&
      !isVariationIntentTerm(term) &&
      !isRarityTerm(term) &&
      !isExpansionAliasTerm(term))
    .map((term) => ({
      term,
      confidence: nameTokenConfidence(name, nameWords, term),
    }))
    .filter((entry) => entry.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence || b.term.length - a.term.length);
  return new Set(candidates.slice(0, 1).map((entry) => entry.term));
}

function nameRootTokens(value) {
  return searchTerms(value)
    .map((term) => compact(term))
    .filter((term) =>
      term.length >= 3 &&
      !CARD_NAME_ROOT_STOP_WORDS.has(term) &&
      !/^[0-9]+$/.test(term) &&
      !isRarityTerm(term) &&
      !isExpansionAliasTerm(term));
}

function rowHasCompoundNameSeparator(row) {
  return /(^|[^a-z0-9])(&|and|tag\s*team|tagteam)([^a-z0-9]|$)/i.test(
    String(row?.name || row?.canonical_name || ''),
  );
}

function compoundNameCoverageAdjustment(row, query, terms, nameWords, baseScore = 0) {
  if (!rowHasCompoundNameSeparator(row)) return 0;
  const queryRoots = [...new Set(nameRootTokens(query))];
  if (queryRoots.length === 0) return 0;
  const candidateRoots = [...new Set(nameRootTokens(row?.canonical_name || row?.name || ''))];
  if (candidateRoots.length < 2 || !candidateRoots.includes(queryRoots[0])) return 0;
  if (queryRoots.length > 1) {
    const missingTypedRoots = queryRoots.filter((root) => !candidateRoots.includes(root));
    if (missingTypedRoots.length > 0) {
      return -Math.max(
        3600 + missingTypedRoots.length * 1200,
        Math.round(Number(baseScore || 0) * 0.65),
      );
    }
    return 0;
  }
  const typedRoots = new Set(
    terms
      .map((term) => compact(term))
      .filter((term) => candidateRoots.includes(term)),
  );
  const untypedExtraRoots = candidateRoots.filter((root) => root !== queryRoots[0] && !typedRoots.has(root));
  if (untypedExtraRoots.length === 0) return 0;

  const compactNameWords = new Set(nameWords.map((word) => compact(word)));
  const queryRootIsExactNameToken = compactNameWords.has(queryRoots[0]);
  const coveragePenalty = Number(baseScore || 0) * (untypedExtraRoots.length / candidateRoots.length);
  const fixedPenalty = queryRootIsExactNameToken
    ? 3600 + untypedExtraRoots.length * 900
    : 1800;
  return -Math.max(fixedPenalty, Math.round(coveragePenalty + 1800));
}

function missingNameRootCoverageAdjustment(row, query, baseScore = 0) {
  const terms = searchTerms(query);
  const hasSpecialRarityPhrase = terms.includes('special') &&
    (terms.includes('illustration') || terms.includes('rare') || terms.includes('sir'));
  const queryRoots = [...new Set(nameRootTokens(query)
    .filter((root) => !(root === 'special' && hasSpecialRarityPhrase)))];
  if (queryRoots.length < 2) return 0;
  const candidateRoots = [...new Set(nameRootTokens(row?.canonical_name || row?.name || ''))];
  if (candidateRoots.length === 0 || !candidateRoots.includes(queryRoots[0])) return 0;
  const missingTypedRoots = queryRoots.filter((root) =>
    !candidateRoots.some((candidateRoot) =>
      candidateRoot === root ||
        candidateRoot.startsWith(root) ||
        root.startsWith(candidateRoot)));
  if (missingTypedRoots.length === 0) return 0;
  return -Math.max(
    2600 + missingTypedRoots.length * 900,
    Math.round(Number(baseScore || 0) * 0.55),
  );
}

function cleanAutocompletePoolLimit(value) {
  const limit = cleanLimit(value ?? 1000);
  return Math.min(Math.max(limit, 100), AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
}

function structuredAutocompleteTokenLimit(value) {
  return cleanLimit(value ?? 15874);
}

function shouldUseSupplementalNameFallback(token, nameRows) {
  if (nameRows.length === 0) return true;
  const term = compact(token.term);
  if (term.length <= 3) {
    return nameRows.some((row) => {
      const nameTerms = searchTerms(String(row.name || ''));
      return !nameTerms.includes(term) &&
        nameTerms.some((nameTerm) => nameTokenConfidence(nameTerm, [nameTerm], term) >= 60);
    });
  }
  return false;
}

function tokenKind(term) {
  if (/^[0-9]+$/.test(term)) return 'number';
  if (isVariationIntentTerm(term)) return 'variation';
  if (isRarityTerm(term)) return 'rarity';
  if (isExpansionAliasTerm(term)) return 'expansion';
  return 'text';
}

function intersectionTokenPlan(query) {
  const terms = searchTerms(query);
  const tokens = terms.map((term) => ({ term, kind: tokenKind(term) }));
  const textTokens = tokens.filter((token) => token.kind === 'text');
  const structuredTokens = tokens.filter((token) =>
    token.kind === 'number' ||
    token.kind === 'variation' ||
    token.kind === 'expansion');
  const rarityTokens = tokens.filter((token) => token.kind === 'rarity');
  if (
    terms.length < 2 ||
    textTokens.length < 1 ||
    structuredTokens.length < 1 ||
    rarityTokens.length > 0
  ) {
    return null;
  }
  return {
    strategy: 'intersection',
    tokens: [...textTokens, ...structuredTokens],
    skippedTokens: rarityTokens,
  };
}

function candidateFanoutPlan(query) {
  const terms = searchTerms(query);
  if (terms.length < 2) return null;
  const tokens = terms.map((term) => ({ term, kind: tokenKind(term) }));
  const textTokens = tokens.filter((token) => token.kind === 'text');
  const structuredTokens = tokens.filter((token) =>
    token.kind === 'number' ||
    token.kind === 'variation' ||
    token.kind === 'expansion' ||
    token.kind === 'rarity');
  const hasStructuredIntent = textTokens.length > 0 && structuredTokens.length > 0;
  const nameProbeTokens = (hasStructuredIntent
    ? textTokens
    : tokens.filter((token) => token.kind === 'text' || token.kind === 'expansion'));
  if (nameProbeTokens.length === 0) return null;
  return {
    strategy: 'candidate_fanout',
    tokens,
    nameProbeTokens,
  };
}

function cleanSearchContext(value, searchTerm, searchLanguage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'missing_context' };
  }
  const previousQuery = cleanSearchTerm(value.query);
  const previousLanguage = cleanLanguage(value.language);
  const currentQuery = cleanSearchTerm(searchTerm);
  const currentLanguage = cleanLanguage(searchLanguage);
  if (!previousQuery || !currentQuery.startsWith(previousQuery) || currentQuery === previousQuery) {
    return { valid: false, reason: 'query_not_extended' };
  }
  if (previousLanguage !== currentLanguage) {
    return { valid: false, reason: 'language_changed' };
  }
  const createdAtMs = Number(value.created_at_ms ?? value.createdAtMs ?? 0);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || Date.now() - createdAtMs > 60_000) {
    return { valid: false, reason: 'context_expired' };
  }
  const cardIds = Array.isArray(value.card_ids ?? value.cardIds)
    ? (value.card_ids ?? value.cardIds)
      .map((id) => Number(id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  const uniqueCardIds = [...new Set(cardIds)].slice(0, SEARCH_CONTEXT_MAX_CARD_IDS);
  if (uniqueCardIds.length === 0) {
    return { valid: false, reason: 'empty_card_ids' };
  }
  if (cardIds.length > SEARCH_CONTEXT_MAX_CARD_IDS) {
    return { valid: false, reason: 'too_many_card_ids' };
  }
  const rawNonNameContext =
    value.non_name_context ?? value.nonNameContext ?? {};
  const rawDepthScores =
    rawNonNameContext && typeof rawNonNameContext === 'object'
      ? rawNonNameContext.depth_scores ?? rawNonNameContext.depthScores
      : null;
  const rawLatestDepths =
    rawNonNameContext && typeof rawNonNameContext === 'object'
      ? rawNonNameContext.latest_depths ?? rawNonNameContext.latestDepths
      : null;
  const rawLatestOrders =
    rawNonNameContext && typeof rawNonNameContext === 'object'
      ? rawNonNameContext.latest_orders ?? rawNonNameContext.latestOrders
      : null;
  const depthScores = {};
  const latestDepths = {};
  const latestOrders = {};
  if (rawDepthScores && typeof rawDepthScores === 'object' && !Array.isArray(rawDepthScores)) {
    for (const [rawId, rawScore] of Object.entries(rawDepthScores)) {
      const id = Number(rawId);
      const score = Number(rawScore);
      if (
        Number.isSafeInteger(id) &&
        id > 0 &&
        Number.isFinite(score) &&
        score > 0 &&
        uniqueCardIds.includes(id)
      ) {
        depthScores[String(id)] = Math.min(score, 512);
      }
    }
  }
  if (rawLatestDepths && typeof rawLatestDepths === 'object' && !Array.isArray(rawLatestDepths)) {
    for (const [rawId, rawDepth] of Object.entries(rawLatestDepths)) {
      const id = Number(rawId);
      const depth = Number(rawDepth);
      if (
        Number.isSafeInteger(id) &&
        id > 0 &&
        Number.isFinite(depth) &&
        depth > 0 &&
        uniqueCardIds.includes(id)
      ) {
        latestDepths[String(id)] = Math.min(Math.trunc(depth), 512);
      }
    }
  }
  if (rawLatestOrders && typeof rawLatestOrders === 'object' && !Array.isArray(rawLatestOrders)) {
    for (const [rawId, rawOrder] of Object.entries(rawLatestOrders)) {
      const id = Number(rawId);
      const order = Number(rawOrder);
      if (
        Number.isSafeInteger(id) &&
        id > 0 &&
        Number.isFinite(order) &&
        order >= 0 &&
        uniqueCardIds.includes(id)
      ) {
        latestOrders[String(id)] = Math.min(Math.trunc(order), SEARCH_CONTEXT_MAX_CARD_IDS);
      }
    }
  }
  return {
    valid: true,
    query: previousQuery,
    language: previousLanguage,
    cardIds: uniqueCardIds,
    depthScores,
    latestDepths,
    latestOrders,
  };
}

function meaningfulSearchDepth(query) {
  return (String(query || '').match(/[a-z0-9]/gi) || []).length;
}

function updateDepthScores(previousContext, searchTerm, searchLanguage, rows) {
  const previous = cleanSearchContext(
    previousContext,
    searchTerm,
    searchLanguage,
  );
  const scores = previous.valid ? { ...previous.depthScores } : {};
  const depth = meaningfulSearchDepth(searchTerm);
  if (depth <= 0) return {};
  const seen = new Set();
  for (const row of rows || []) {
    const id = String(row.card_id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    scores[id] = Math.min(Number(scores[id] || 0) + depth, 512);
    if (seen.size >= SEARCH_CONTEXT_MAX_CARD_IDS) break;
  }
  return scores;
}

function updateDepthMetadata(previousContext, searchTerm, searchLanguage, rows) {
  const previous = cleanSearchContext(
    previousContext,
    searchTerm,
    searchLanguage,
  );
  const depth = meaningfulSearchDepth(searchTerm);
  const latestDepths = previous.valid ? { ...previous.latestDepths } : {};
  const latestOrders = previous.valid ? { ...previous.latestOrders } : {};
  if (depth <= 0) {
    return { latestDepths, latestOrders };
  }
  const seen = new Set();
  let order = 0;
  for (const row of rows || []) {
    const id = String(row.card_id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    latestDepths[id] = depth;
    latestOrders[id] = order;
    order += 1;
    if (seen.size >= SEARCH_CONTEXT_MAX_CARD_IDS) break;
  }
  return { latestDepths, latestOrders };
}

function buildSearchContext(
  searchTerm,
  searchLanguage,
  rows,
  strategy,
  previousContext = null,
  candidateIdLimit = null,
) {
  const contextLimit = cleanContextCandidateIdLimit(
    candidateIdLimit ?? autocompleteCandidateIdAppliedLimit(searchTerm),
  );
  const cardIds = [];
  const seen = new Set();
  if (contextLimit > 0) {
    for (const row of rows || []) {
      const id = String(row.card_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cardIds.push(id);
      if (cardIds.length >= contextLimit) break;
    }
  }
  const candidateIdLadder = autocompleteCandidateIdLadder(searchTerm);
  const context = {
    query: cleanSearchTerm(searchTerm),
    language: cleanLanguage(searchLanguage),
    card_ids: cardIds,
    created_at_ms: Date.now(),
    strategy,
    candidate_id_ladder: candidateIdLadder,
  };
  const depthScores = updateDepthScores(previousContext, searchTerm, searchLanguage, rows);
  const depthMetadata = updateDepthMetadata(previousContext, searchTerm, searchLanguage, rows);
  const nonNameContext = rows?.nonNameContext &&
    typeof rows.nonNameContext === 'object'
    ? { ...rows.nonNameContext }
    : {};
  const scopedDepthScores = {};
  const scopedLatestDepths = {};
  const scopedLatestOrders = {};
  for (const id of cardIds) {
    if (Number(depthScores[id] || 0) > 0) {
      scopedDepthScores[id] = depthScores[id];
    }
    if (Number(depthMetadata.latestDepths[id] || 0) > 0) {
      scopedLatestDepths[id] = depthMetadata.latestDepths[id];
    }
    if (Number(depthMetadata.latestOrders[id] || 0) >= 0 &&
        Object.prototype.hasOwnProperty.call(depthMetadata.latestOrders, id)) {
      scopedLatestOrders[id] = depthMetadata.latestOrders[id];
    }
  }
  if (Object.keys(scopedDepthScores).length > 0) {
    nonNameContext.depth_scores = scopedDepthScores;
    nonNameContext.depth_unit = 'meaningful_query_character';
  }
  if (Object.keys(scopedLatestDepths).length > 0) {
    nonNameContext.latest_depths = scopedLatestDepths;
  }
  if (Object.keys(scopedLatestOrders).length > 0) {
    nonNameContext.latest_orders = scopedLatestOrders;
  }
  if (Object.keys(nonNameContext).length > 0) {
    context.non_name_context = nonNameContext;
  }
  const candidateLabels = candidateLabelsForRows(rows, contextLimit || 0);
  if (candidateLabels?.length > 0) {
    context.candidate_labels = candidateLabels;
  }
  return context;
}

function candidateLabelsForRows(rows, limit = 100) {
  if (limit <= 0) return undefined;
  const labels = [];
  const seen = new Set();
  for (const row of rows || []) {
    const id = String(row.card_id || row.id || '').trim();
    const name = String(row.name || '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    labels.push({
      id,
      name,
      item_kind: String(row.item_kind || 'single'),
      product_type: String(row.product_type || 'card'),
      set_name: String(row.set_name || ''),
      card_number: String(row.card_number || ''),
      trainer_name: String(row.trainer_name || ''),
    });
    if (labels.length >= limit) break;
  }
  return labels;
}

function intersectRows(rowGroups, limit) {
  if (!rowGroups.length) return [];
  const [firstRows, ...remainingGroups] = rowGroups;
  const remainingIds = remainingGroups.map((rows) =>
    new Set((rows || []).map((row) => String(row.card_id || '')).filter(Boolean)),
  );
  const result = [];
  const seen = new Set();
  for (const row of firstRows || []) {
    const id = String(row.card_id || '');
    if (!id || seen.has(id)) continue;
    if (remainingIds.every((ids) => ids.has(id))) {
      seen.add(id);
      result.push(row);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function rowMatchesIntersectionToken(row, token) {
  const term = token.term;
  const normalizedTerm = compact(term);
  if (!normalizedTerm) return false;
  if (token.kind === 'text') {
    const name = String(row.name || '').toLowerCase();
    const nameWords = searchTerms(name);
    return nameTokenConfidence(name, nameWords, term) >= 60;
  }
  if (token.kind === 'variation') {
    return rowHasVariationIntent(row, term);
  }
  if (token.kind === 'number') {
    const number = String(row.card_number || row.version || row.card_id || '')
      .toLowerCase();
    const compactNumber = compact(number);
    return number === term ||
      compactNumber === normalizedTerm ||
      searchTerms(number).includes(term) ||
      number.startsWith(term) ||
      compactNumber.startsWith(normalizedTerm);
  }
  if (token.kind === 'expansion') {
    return rowHasExpansionAlias(row, term);
  }
  return false;
}

function filterRowsByAnyStructuredToken(rows, structuredTokens) {
  const tokens = (structuredTokens || []).filter((token) =>
    token.kind === 'number' ||
    token.kind === 'variation' ||
    token.kind === 'expansion');
  if (!Array.isArray(rows) || rows.length === 0 || tokens.length === 0) {
    return {
      rows,
      applied: false,
      filteredCount: 0,
    };
  }
  const filteredRows = rows.filter((row) =>
    tokens.some((token) => rowMatchesIntersectionToken(row, token)));
  return {
    rows: filteredRows.length > 0 ? filteredRows : rows,
    applied: filteredRows.length > 0,
    filteredCount: Math.max(rows.length - filteredRows.length, 0),
  };
}

function requiredNameTokensForQuery(query) {
  const tokens = searchTerms(query).map((term, index) => ({ term, kind: tokenKind(term), index }));
  const textTokens = tokens.filter((token) => token.kind === 'text');
  const textOnlyTokens = textTokens.map(({ index, ...token }) => token);
  const firstTextIndex = textTokens.length > 0 ? textTokens[0].index : -1;
  const structuredTokens = tokens.filter((token) =>
    (
      token.kind === 'number' ||
      token.kind === 'variation' ||
      token.kind === 'expansion'
    ));
  if (tokens.length > 1 && textTokens.length > 0 && structuredTokens.length > 0) {
    const allNameAndStructuredTokens = [...textTokens, ...structuredTokens]
      .map(({ index, ...token }) => token);
    if (
      structuredTokens.some((token) => token.kind === 'number' || token.kind === 'expansion') ||
      structuredTokens.filter((token) => token.kind === 'variation').length > 1
    ) {
      return allNameAndStructuredTokens;
    }
    return textOnlyTokens;
  }
  if (textTokens.length > 0) {
    return textOnlyTokens;
  }
  if (tokens.length > 1 && structuredTokens.length > 0) {
    return structuredTokens.map(({ index, ...token }) => token);
  }
  return [];
}

function filterRowsByRequiredNameTokens(rows, query) {
  const requiredTokens = requiredNameTokensForQuery(query);
  if (!Array.isArray(rows) || rows.length === 0 || requiredTokens.length === 0) {
    return {
      rows,
      requiredTokens,
      applied: false,
      filteredCount: 0,
    };
  }
  const filteredRows = rows.filter((row) =>
    requiredTokens.every((token) => rowMatchesIntersectionToken(row, token)));
  return {
    rows: filteredRows.length > 0 ? filteredRows : rows,
    requiredTokens,
    applied: filteredRows.length > 0,
    filteredCount: Math.max(rows.length - filteredRows.length, 0),
  };
}

async function searchNameTokenFallbackWithDatabase(
  searchTerm,
  resultLimit,
  resultOffset = 0,
  searchLanguage = 'en',
  query = marketplaceQuery,
) {
  const result = await query(
    `
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset,
          $4::text as language
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        (
          case
            when names.compact_name = n.compact_q then 3300
            when names.compact_name like n.compact_q || '%' then 3180
            else 3000
          end
        )::real as search_rank
      from normalized n
      join public.marketplace_card_names_for_language(n.language) names
        on names.compact_name = n.compact_q
        or names.compact_name like n.compact_q || '%'
        or (
          length(n.compact_q) between 3 and 8
          and exists (
            select 1
            from unnest(names.name_tokens) name_token
            where abs(length(public.marketplace_search_compact(name_token)) - length(n.compact_q)) <= 1
              and left(public.marketplace_search_compact(name_token), 2) = left(n.compact_q, 2)
              and public.marketplace_edit_distance(public.marketplace_search_compact(name_token), n.compact_q) <= 1
          )
        )
        or n.compact_q = any(names.name_tokens)
      join public.marketplace_search_candidates c
        on coalesce(nullif(c.canonical_name, ''), c.name) = names.name
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      where n.compact_q <> ''
      order by search_rank desc, c.name asc, candidate_number.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    `,
    [searchTerm, resultLimit, resultOffset, searchLanguage],
  );
  return result.rows;
}

async function searchFastNamePreviewWithDatabase(
  searchTerm,
  resultLimit,
  searchLanguage = 'en',
  query = marketplaceQuery,
) {
  const terms = searchTerms(searchTerm);
  const structuredTokens = terms
    .map((term) => ({ term, kind: tokenKind(term) }))
    .filter((token) => token.kind !== 'text' && token.kind !== 'rarity');
  const candidateTokens = terms
    .filter((term) =>
      term &&
      !/^[0-9]+$/.test(term) &&
      !isVariationIntentTerm(term) &&
      !isRarityTerm(term))
    .slice(0, 4);
  const lookupLimit = structuredTokens.length > 0
    ? Math.min(Math.max(resultLimit * 40, 500), AUTOCOMPLETE_SQL_SAFE_POOL_CAP)
    : resultLimit;
  const rowGroups = await Promise.all(candidateTokens.map((term) =>
    searchNameTokenFallbackWithDatabase(term, lookupLimit, 0, searchLanguage, query)));
  const mergedRows = mergeRowsPreservingBest(rowGroups, lookupLimit);
  if (structuredTokens.length === 0) {
    return mergedRows.slice(0, resultLimit);
  }
  const filteredRows = await filterRowsByStoredStructuredTokens(
    mergedRows,
    structuredTokens,
    query,
  );
  return filteredRows.slice(0, resultLimit);
}

async function searchCanonicalNameEntitiesWithDatabase(
  searchTerm,
  resultLimit,
  searchLanguage = 'en',
  query = marketplaceQuery,
) {
  const values = [searchTerm, resultLimit, searchLanguage];
  const fastResult = await query(
    `
      with normalized as (
        select
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 200) as clean_limit,
          $3::text as language
      )
      select
        names.name,
        (
          case
            when names.compact_name = n.compact_q then 1400
            when names.compact_name like n.compact_q || '%' then 1220
            when n.compact_q = any(names.name_tokens) then 1180
            else 980
          end
        )::real as token_score
      from normalized n
      join public.marketplace_card_names_for_language(n.language) names
        on names.compact_name = n.compact_q
        or names.compact_name like n.compact_q || '%'
        or n.compact_q = any(names.name_tokens)
      where n.compact_q <> ''
      order by token_score desc, length(names.compact_name), names.name
      limit (select clean_limit from normalized)
    `,
    values,
  );
  if (fastResult.rows.length > 0) {
    return fastResult.rows;
  }
  const fuzzyResult = await query(
    `
      with normalized as (
        select
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 200) as clean_limit,
          $3::text as language
      )
      select
        names.name,
        980::real as token_score
      from normalized n
      join public.marketplace_card_names_for_language(n.language) names
        on (
          length(n.compact_q) between 3 and 8
          and exists (
            select 1
            from unnest(names.name_tokens) name_token
            where abs(length(public.marketplace_search_compact(name_token)) - length(n.compact_q)) <= 1
              and left(public.marketplace_search_compact(name_token), 2) = left(n.compact_q, 2)
              and public.marketplace_edit_distance(public.marketplace_search_compact(name_token), n.compact_q) <= 1
          )
        )
      where n.compact_q <> ''
      order by token_score desc, length(names.compact_name), names.name
      limit (select clean_limit from normalized)
    `,
    values,
  );
  return fuzzyResult.rows;
}

async function searchCandidatesForCanonicalNamesWithDatabase(
  canonicalNames,
  resultLimit,
  query = marketplaceQuery,
) {
  if (!canonicalNames.length) return [];
  const result = await query(
    `
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        c.search_weight::real as search_rank
      from public.marketplace_search_candidates c
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where coalesce(nullif(c.canonical_name, ''), c.name) = any($1::text[])
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight
      order by c.search_weight desc, c.name asc, c.card_number asc
      limit $2::integer
    `,
    [canonicalNames, resultLimit],
  );
  return result.rows;
}

async function searchNameOnlyAutocompleteWithCardNameFanout(
  searchTerm,
  poolLimit,
  searchLanguage,
  debug,
  query = marketplaceQuery,
) {
  const tokens = searchTerms(searchTerm).map((term) => ({ term, kind: tokenKind(term) }));
  const nameTokens = tokens.filter((token) =>
    token.kind === 'text' || token.kind === 'expansion');
  if (tokens.length === 0 || nameTokens.length === 0 || nameTokens.length !== tokens.length) {
    return null;
  }
  const started = Date.now();
  const directRows = await searchNameOnlyRowsWithDatabase(
    nameTokens.map((token) => token.term),
    poolLimit,
    searchLanguage,
    query,
  );
  if (directRows.length > 0) {
    if (debug) {
      debug.tokenPlan = {
        strategy: 'name_table_direct',
        tokens,
        candidateRowCount: directRows.length,
        matchedRowCount: directRows.length,
        durationMs: Date.now() - started,
      };
    }
    return directRows;
  }
  const nameEntityGroups = await Promise.all(nameTokens.map(async (token) => ({
    ...token,
    entities: await searchCanonicalNameEntitiesWithDatabase(
      token.term,
      tokens.length === 1 ? 80 : 30,
      searchLanguage,
      query,
    ),
  })));
  const groupsWithEntities = nameEntityGroups.filter((entry) => entry.entities.length > 0);
  if (groupsWithEntities.length === 0) {
    return null;
  }

  const exactNameSets = groupsWithEntities.map((entry) =>
    new Set(entry.entities
      .filter((entity) => compact(entity.name) === compact(entry.term))
      .map((entity) => entity.name)));
  const exactSharedNames = exactNameSets.length > 0
    ? [...exactNameSets[0]].filter((name) => exactNameSets.every((set) => set.has(name)))
    : [];
  const combinedNameScores = new Map();
  for (const entry of groupsWithEntities) {
    for (const entity of entry.entities) {
      const current = Number(combinedNameScores.get(entity.name) || 0);
      combinedNameScores.set(entity.name, current + Number(entity.token_score || 0));
    }
  }
  const selectedNames = (exactSharedNames.length > 0
    ? exactSharedNames
    : [...combinedNameScores.entries()]
      .filter(([, score]) => score >= 980 * groupsWithEntities.length)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([name]) => name))
    .slice(0, tokens.length === 1 ? 80 : 40);
  if (selectedNames.length === 0) {
    return null;
  }
  const candidateRows = await searchCandidatesForCanonicalNamesWithDatabase(
    selectedNames,
    Math.min(Math.max(poolLimit * 40, 500), 4000),
    query,
  );
  const ranked = [];
  for (const row of candidateRows) {
    const normalizedName = String(row.canonical_name || row.name || '').toLowerCase();
    const nameWords = searchTerms(normalizedName);
    const tokenScores = nameTokens.map((token) =>
      Math.max(
        nameTokenConfidence(normalizedName, nameWords, token.term),
        fieldTokenScore(row, token),
      ));
    if (tokenScores.some((score) => score <= 0)) continue;
    const entityScore = Number(combinedNameScores.get(row.canonical_name || row.name) || 0);
    ranked.push({
      ...row,
      search_rank:
        entityScore +
        tokenScores.reduce((sum, score) => sum + score, 0) * 10 +
        Number(row.search_rank || 0),
    });
  }
  ranked.sort((left, right) =>
    Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
    String(left.name || '').localeCompare(String(right.name || '')) ||
    String(left.card_number || '').localeCompare(String(right.card_number || '')));
  if (debug) {
    debug.tokenPlan = {
      strategy: 'name_table_fanout',
      tokens,
      nameTokenCount: nameTokens.length,
      matchedNameTokens: groupsWithEntities.map((entry) => ({
        term: entry.term,
        entityCount: entry.entities.length,
        topEntities: entry.entities.slice(0, 6).map((entity) => entity.name),
      })),
      canonicalNameCount: selectedNames.length,
      candidateRowCount: candidateRows.length,
      matchedRowCount: ranked.length,
      durationMs: Date.now() - started,
    };
  }
  return ranked.length > 0 ? ranked.slice(0, poolLimit) : null;
}

async function searchCombinedCardNameWithDatabase(
  terms,
  poolLimit,
  query = marketplaceQuery,
) {
  const cleanTerms = [...new Set((terms || [])
    .map((term) => cleanSearchTerm(term))
    .filter((term) => term && !/^[0-9]+$/.test(term) && !isVariationIntentTerm(term) && !isRarityTerm(term)))]
    .slice(0, 4);
  if (cleanTerms.length < 2) return [];
  const result = await query(
    `
      with input_terms as (
        select public.marketplace_search_compact(term) as compact_term
        from unnest($1::text[]) term
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        '{}'::text[] as variation_keys,
        '' as normalized_number,
        '' as compact_number,
        '' as normalized_set,
        '' as compact_set,
        '' as normalized_trainer,
        '' as compact_trainer,
        '' as normalized_variant,
        '' as compact_variant,
        (c.search_weight + 2600)::real as search_rank
      from public.marketplace_search_candidates c
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      where c.item_kind <> 'product'
        and (
          select bool_and(
            public.marketplace_search_compact(coalesce(nullif(c.source_name, ''), c.name))
              like '%' || input_terms.compact_term || '%'
          )
          from input_terms
        )
      order by c.search_weight desc, c.name asc, candidate_number.card_number asc
      limit $2::integer
    `,
    [cleanTerms, Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP)],
  );
  return result.rows;
}

async function searchNameOnlyRowsWithDatabase(
  terms,
  poolLimit,
  searchLanguage = 'en',
  query = marketplaceQuery,
) {
  const cleanTerms = [...new Set((terms || [])
    .map((term) => cleanSearchTerm(term))
    .filter(Boolean))]
    .slice(0, 5);
  if (cleanTerms.length === 0) return [];
  const result = await query(
    `
      with input_terms as (
        select
          term,
          public.marketplace_search_compact(term) as compact_term
        from unnest($1::text[]) term
      ),
      matched_names as (
        select
          names.name,
          sum(
            case
              when names.compact_name = input_terms.compact_term then 1400
              when names.compact_name like input_terms.compact_term || '%' then 1220
              when input_terms.compact_term = any(names.name_tokens) then 1180
              else 980
            end
          )::real as name_score,
          count(distinct input_terms.term)::integer as matched_terms
        from input_terms
        join public.marketplace_card_names_for_language($3::text) names
          on names.compact_name = input_terms.compact_term
          or names.compact_name like input_terms.compact_term || '%'
          or input_terms.compact_term = any(names.name_tokens)
        where input_terms.compact_term <> ''
        group by names.name
        having count(distinct input_terms.term) = (select count(*) from input_terms)
        order by name_score desc, length(public.marketplace_search_compact(names.name)), names.name
        limit 80
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        '{}'::text[] as variation_keys,
        '' as normalized_number,
        '' as compact_number,
        '' as normalized_set,
        '' as compact_set,
        '' as normalized_trainer,
        '' as compact_trainer,
        '' as normalized_variant,
        '' as compact_variant,
        (matched_names.name_score + c.search_weight)::real as search_rank
      from matched_names
      join public.marketplace_search_candidates c
        on coalesce(nullif(c.canonical_name, ''), c.name) = matched_names.name
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      order by search_rank desc, c.name asc, candidate_number.card_number asc
      limit $2::integer
    `,
    [cleanTerms, Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP), searchLanguage],
  );
  return result.rows;
}

async function searchCandidatesForCardIdsWithDatabase(
  cardIds,
  query = marketplaceQuery,
) {
  if (!cardIds.length) return [];
  const result = await query(
    `
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        c.search_weight::real as search_rank
      from public.marketplace_search_candidates c
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where c.card_id = any($1::bigint[])
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight
      order by c.search_weight desc, c.name asc, c.card_number asc
    `,
    [cardIds],
  );
  return result.rows;
}

function fuzzyPrefixMatch(value, term, maxDistance = 2) {
  const compactValue = compact(value);
  const compactTerm = compact(term);
  if (!compactValue || compactTerm.length < 4) return false;
  if (compactValue.startsWith(compactTerm) || compactValue.includes(compactTerm)) {
    return true;
  }
  return compactValue.startsWith(compactTerm.slice(0, 3)) &&
    boundedDistance(compactValue.slice(0, compactTerm.length), compactTerm, maxDistance) <= maxDistance;
}

function fieldTokenScore(row, token) {
  const term = token.term;
  const compactTerm = compact(term);
  if (!compactTerm) return 0;
  if (token.kind === 'number') {
    const normalizedNumberTerms = searchTerms(String(row.normalized_number || row.card_number || ''));
    const compactNumber = String(row.compact_number || compact(row.card_number || ''));
    if (normalizedNumberTerms.includes(term) || compactNumber === compactTerm) return 1400;
    if (compactNumber.includes(compactTerm)) return 1100;
    return 0;
  }
  if (token.kind === 'variation') {
    const variations = new Set((row.variation_keys || []).map(compact));
    if (
      variationTermTargets(term).some((target) => variations.has(target)) ||
      rowHasVariationIntent(row, term)
    ) return 1300;
    return 0;
  }
  if (token.kind === 'expansion') {
    if (rowHasExpansionAlias(row, term)) return 1250;
    if (fuzzyPrefixMatch(row.set_name, term)) return 980;
    return 0;
  }
  if (token.kind === 'rarity') {
    return rowHasRarity(row, term) ? 860 : 0;
  }
  const trainer = String(row.normalized_trainer || row.trainer_name || '');
  const set = String(row.normalized_set || row.set_name || '');
  const variant = String(row.normalized_variant || row.product_variant || '');
  if (searchTerms(trainer).includes(term) || compact(trainer) === compactTerm) return 1050;
  if (fuzzyPrefixMatch(trainer, term, 1)) return 900;
  if (searchTerms(set).includes(term) || compact(set) === compactTerm) return 780;
  if (fuzzyPrefixMatch(set, term)) return 680;
  if (searchTerms(variant).includes(term) || compact(variant) === compactTerm) return 420;
  return 0;
}

function predictivePoolEnabled() {
  return process.env.MARKETPLACE_PREDICTIVE_POOL_ENABLED === '1';
}

function predictivePoolStrictMode() {
  return process.env.MARKETPLACE_PREDICTIVE_POOL_STRICT !== '0';
}

function supabasePredictionConfigured() {
  return supabaseNameIndexConfigured() || supabaseRestNameIndexConfigured();
}

function predictivePoolPlan(query) {
  const terms = searchTerms(query);
  const tokens = terms.map((term) => ({ term, kind: tokenKind(term) }));
  const textTokens = tokens.filter((token) => token.kind === 'text');
  const dimensionTokens = tokens.filter((token) =>
    token.kind === 'number' ||
    token.kind === 'expansion' ||
    token.kind === 'rarity' ||
    token.kind === 'variation');
  if (meaningfulSearchDepth(query) < 2) return null;
  return {
    strategy: 'predictive_dimension_pool',
    tokens,
    textTokens,
    dimensionTokens,
    nameFragmentCandidates: predictiveNameFragmentCandidates(tokens),
    sources: PREDICTIVE_DIMENSION_SOURCES,
  };
}

function firstNameAnchorFromPredictionContext(predictionContext, tokens, searchLanguage) {
  const context = cleanPredictionContext(predictionContext, tokens.map((token) => token.term).join(' '), searchLanguage);
  if (!context.valid) return null;
  for (let prefixLength = tokens.length - 1; prefixLength >= 1; prefixLength -= 1) {
    const prefixTokens = tokens.slice(0, prefixLength);
    if (prefixTokens.some((token) =>
      token.kind !== 'text' &&
      token.kind !== 'rarity' &&
      token.kind !== 'variation')) continue;
    if (prefixTokens.length === 1 && MODIFIER_ONLY_ANCHOR_WORDS.has(compact(prefixTokens[0].term))) continue;
    const normalizedPrefix = compact(prefixTokens.map((token) => token.term).join(' '));
    if (!normalizedPrefix) continue;
    const prediction = context.candidates.find((candidate) =>
      candidate.normalized === normalizedPrefix &&
      Number(candidate.confidence || 0) >= FIRST_NAME_ANCHOR_MIN_CONFIDENCE);
    if (!prediction) continue;
    return {
      prefixLength,
      nameFragment: prefixTokens.map((token) => token.term).join(' '),
      nameTerms: prefixTokens.map((token) => token.term),
      predictions: [prediction],
      source: 'prediction_context',
    };
  }
  return null;
}

async function firstNameAnchorFromSupabase(tokens, searchLanguage, debug, nameIndexQuery) {
  for (let prefixLength = tokens.length - 1; prefixLength >= 1; prefixLength -= 1) {
    const prefixTokens = tokens.slice(0, prefixLength);
    if (prefixTokens.some((token) =>
      token.kind !== 'text' &&
      token.kind !== 'rarity' &&
      token.kind !== 'variation')) continue;
    if (prefixTokens.length === 1 && MODIFIER_ONLY_ANCHOR_WORDS.has(compact(prefixTokens[0].term))) continue;
    const nameFragment = prefixTokens.map((token) => token.term).join(' ');
    const normalizedPrefix = compact(nameFragment);
    if (!normalizedPrefix) continue;
    const predictions = await predictedNameTokensFromSupabase(
      nameFragment,
      searchLanguage,
      debug,
      nameIndexQuery,
      { strict: false },
    );
    const exactPredictions = predictions.filter((prediction) =>
      compact(prediction.normalized || prediction.display) === normalizedPrefix &&
      Number(prediction.confidence || 0) >= FIRST_NAME_ANCHOR_MIN_CONFIDENCE);
    if (exactPredictions.length === 0) continue;
    return {
      prefixLength,
      nameFragment,
      nameTerms: prefixTokens.map((token) => token.term),
      predictions: exactPredictions,
      source: 'supabase_name_prefix',
    };
  }
  return null;
}

async function firstNameAnchorForPredictivePlan(plan, searchLanguage, debug, nameIndexQuery, predictionContext) {
  if (!plan || plan.tokens.length < 2) return null;
  const contextAnchor = firstNameAnchorFromPredictionContext(predictionContext, plan.tokens, searchLanguage);
  if (contextAnchor) return contextAnchor;
  return firstNameAnchorFromSupabase(plan.tokens, searchLanguage, debug, nameIndexQuery);
}

function anchoredPredictionSets(anchor, tokens) {
  if (!anchor) return null;
  return [{
    nameFragment: anchor.nameFragment,
    nameTerms: anchor.nameTerms,
    nameTokenIndexes: Array.from({ length: anchor.prefixLength }, (_, index) => index),
    dimensionTokens: tokens.slice(anchor.prefixLength).map((token) => ({
      ...token,
      sourceHint: token.kind === 'text' ? 'expansion' : token.sourceHint,
    })),
    reason: 'first_name_anchor',
    predictionContextSource: anchor.source,
    predictions: anchor.predictions,
  }];
}

function cleanPredictionContext(value, searchTerm, searchLanguage) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'missing_context' };
  }
  const previousLanguage = cleanLanguage(value.language ?? value.search_language);
  const currentLanguage = cleanLanguage(searchLanguage);
  if (previousLanguage !== currentLanguage) {
    return { valid: false, reason: 'language_changed' };
  }
  const normalizedFragment = compact(
    value.normalized_fragment ??
    value.normalizedFragment ??
    value.prediction_fragment ??
    value.predictionFragment ??
    value.fragment ??
    value.query,
  );
  const queryCompact = compact(searchTerm);
  if (!normalizedFragment || !queryCompact.startsWith(normalizedFragment)) {
    return { valid: false, reason: 'fragment_not_in_query' };
  }
  const createdAtMs = Number(value.created_at_ms ?? value.createdAtMs ?? 0);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || Date.now() - createdAtMs > 60_000) {
    return { valid: false, reason: 'context_expired' };
  }
  const candidates = (Array.isArray(value.candidates) ? value.candidates : [])
    .map((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
      const display = String(candidate.display_token ?? candidate.display ?? '').trim();
      const normalized = compact(candidate.normalized_token ?? candidate.normalized ?? display);
      if (!display || !normalized) return null;
      const candidateCardIds = predictionCandidateCardIds(candidate, 64);
      const representativeCardIds = Array.isArray(candidate.representative_card_ids)
        ? candidate.representative_card_ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 64)
        : candidateCardIds.slice(0, 8);
      return {
        normalized,
        normalized_token: normalized,
        display,
        display_token: display,
        confidence: Number(candidate.confidence || 0),
        score: Number(candidate.score || 0),
        source_rank: Number(candidate.source_rank || candidate.sourceRank || index + 1),
        language: String(candidate.language || previousLanguage),
        matched_prefix: String(candidate.matched_prefix || normalizedFragment),
        ids_count: Number(candidate.ids_count || candidate.idsCount || candidateCardIds.length || representativeCardIds.length || 0),
        card_count: Number(candidate.card_count || candidate.cardCount || candidateCardIds.length || representativeCardIds.length || 0),
        representative_card_ids: representativeCardIds,
        candidate_card_ids: candidateCardIds.length > 0 ? candidateCardIds : representativeCardIds,
      };
    })
    .filter(Boolean)
    .slice(0, SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
  if (candidates.length === 0) {
    return { valid: false, reason: 'empty_candidates' };
  }
  return {
    valid: true,
    normalizedFragment,
    language: previousLanguage,
    candidates,
  };
}

function predictionSetsFromContext(plan, predictionContext, searchTerm, searchLanguage, debug) {
  const context = cleanPredictionContext(predictionContext, searchTerm, searchLanguage);
  if (!context.valid) {
    if (debug) {
      debug.predictionContext = {
        used: false,
        reason: context.reason,
      };
    }
    return null;
  }
  const candidates = plan.nameFragmentCandidates.length > 0
    ? plan.nameFragmentCandidates
    : [{
        nameFragment: plan.textTokens.map((token) => token.term).join(' '),
        nameTerms: plan.textTokens.map((token) => token.term),
        dimensionTokens: plan.dimensionTokens,
        reason: 'text_tokens',
      }];
  const predictionSets = candidates
    .filter((candidate) => candidate.nameFragment && compact(candidate.nameFragment).startsWith(context.normalizedFragment))
    .map((candidate) => ({
      ...candidate,
      predictions: context.candidates,
      predictionContextSource: 'client_prediction_context',
    }));
  if (debug) {
    debug.predictionContext = {
      used: predictionSets.length > 0,
      reason: predictionSets.length > 0 ? undefined : 'no_matching_name_fragment',
      normalizedFragment: context.normalizedFragment,
      candidateCount: context.candidates.length,
      predictionSetCount: predictionSets.length,
    };
  }
  return predictionSets.length > 0 ? predictionSets : null;
}

function predictiveNameFragmentCandidates(tokens) {
  const indexedTokens = (tokens || []).map((token, index) => ({ ...token, index }));
  const textTokens = indexedTokens.filter((token) => token.kind === 'text');
  if (textTokens.length === 0) return [];
  const candidates = [];
  const addCandidate = (nameIndexes, reason) => {
    const indexSet = new Set(nameIndexes);
    const nameTerms = indexedTokens
      .filter((token) => indexSet.has(token.index))
      .map((token) => token.term);
    if (nameTerms.length === 0) return;
    const minNameIndex = Math.min(...nameIndexes);
    const maxNameIndex = Math.max(...nameIndexes);
    const dimensionTokensForCandidate = indexedTokens
      .filter((token) => !indexSet.has(token.index))
      .map((token) => {
        if (token.kind !== 'text') {
          return { term: token.term, kind: token.kind };
        }
        const sourceHint = token.index < minNameIndex
          ? 'variation_owner'
          : token.index > maxNameIndex
            ? 'expansion'
            : 'variation_owner';
        return { term: token.term, kind: 'text', sourceHint };
      });
    const nameFragment = nameTerms.join(' ');
    const key = `${compact(nameFragment)}|${dimensionTokensForCandidate.map((token) => `${token.sourceHint || token.kind}:${token.term}`).join(',')}`;
    if (candidates.some((candidate) => candidate.key === key)) return;
    candidates.push({
      key,
      nameFragment,
      nameTerms,
      nameTokenIndexes: [...indexSet],
      dimensionTokens: dimensionTokensForCandidate,
      reason,
    });
  };

  addCandidate(textTokens.map((token) => token.index), 'all_text_tokens');

  const firstTextIndex = textTokens[0].index;
  const lastTextIndex = textTokens[textTokens.length - 1].index;
  const leadingText = [];
  for (const token of indexedTokens) {
    if (token.index < firstTextIndex) continue;
    if (token.kind !== 'text') break;
    leadingText.push(token);
  }
  for (let length = leadingText.length - 1; length >= 1; length -= 1) {
    addCandidate(leadingText.slice(0, length).map((token) => token.index), 'leading_text_prefix');
  }

  if (firstTextIndex === lastTextIndex && indexedTokens.length > 1) {
    addCandidate([firstTextIndex], 'single_text_token');
  } else if (lastTextIndex < indexedTokens.length - 1) {
    addCandidate([lastTextIndex], 'last_text_before_structured_token');
  }

  return candidates.slice(0, 8).map(({ key, ...candidate }) => candidate);
}

function dimensionTokensForSource(source, tokens) {
  return (tokens || []).filter((token) => {
    if (source === 'number') return token.kind === 'number';
    if (source === 'expansion') {
      return token.kind === 'expansion' ||
        token.sourceHint === 'expansion' ||
        (token.kind === 'text' && !token.sourceHint);
    }
    if (source === 'rarity') return token.kind === 'rarity';
    if (source === 'variation_owner') {
      return token.kind === 'variation' ||
        token.sourceHint === 'variation_owner' ||
        (token.kind === 'text' && !token.sourceHint);
    }
    return false;
  });
}

function sourceFlagsFor(row) {
  const flags = row?.predictive_source_flags;
  if (Array.isArray(flags)) return flags.map(String).filter(Boolean);
  if (flags && typeof flags === 'object') {
    return Object.keys(flags).filter((key) => flags[key]);
  }
  return [];
}

function predictiveSourceWeight(source) {
  switch (source) {
    case 'name':
      return 700000;
    case 'predicted_name_verified':
      return 680000;
    case 'variation_owner':
      return 520000;
    case 'number':
      return 390000;
    case 'expansion':
      return 260000;
    case 'rarity':
      return 150000;
    default:
      return 50000;
  }
}

function predictiveConfidenceBoost(confidence) {
  const value = Number(confidence || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 70 ? value * 4200 : value * 2300;
}

function predictivePrefixDepthBoost(prediction, query) {
  const compactQuery = compact(query);
  const normalized = String(prediction?.normalized || prediction?.normalized_token || '');
  if (!compactQuery || !normalized) return 0;
  if (normalized === compactQuery) return compactQuery.length * 1800;
  if (normalized.startsWith(compactQuery)) return compactQuery.length * 1500;
  return Math.min(compactQuery.length, normalized.length) * 800;
}

function mergePredictivePoolRows(sourceResults, query, poolLimit) {
  const byId = new Map();
  for (const sourceResult of sourceResults || []) {
    if (sourceResult?.status !== 'fulfilled') continue;
    const source = sourceResult.source;
    const rows = sourceResult.rows || [];
    rows.forEach((row, index) => {
      const id = rowKey(row);
      if (!id) return;
      const existing = byId.get(id) || {
        ...row,
        search_rank: 0,
        predictive_score_components: {},
        predictive_source_flags: [],
        predictive_best_rank: Number.MAX_SAFE_INTEGER,
      };
      const predictionBoost = predictiveConfidenceBoost(row.predicted_name_confidence) +
        predictivePrefixDepthBoost(row.predicted_name, sourceResult.query || query);
      const matchBoost = Number(row.predictive_dimension_match_count || 0) * 180000;
      const sourceScore = predictiveSourceWeight(source) +
        Math.max(0, 50000 - index * 10) +
        predictionBoost +
        matchBoost +
        Number(row.search_rank || 0) * 0.2;
      existing.search_rank = Math.max(Number(existing.search_rank || 0), 0) + sourceScore;
      existing.predictive_score_components[source] =
        Math.max(Number(existing.predictive_score_components[source] || 0), sourceScore);
      if (predictionBoost > 0) {
        existing.predictive_score_components.predicted_name_confidence =
          Math.max(Number(existing.predictive_score_components.predicted_name_confidence || 0), predictionBoost);
      }
      if (matchBoost > 0) {
        existing.predictive_score_components.dimension_matches =
          Math.max(Number(existing.predictive_score_components.dimension_matches || 0), matchBoost);
      }
      existing.predictive_source_flags = [...new Set([
        ...sourceFlagsFor(existing),
        source,
        ...(row.predictive_source_flags || []),
      ])];
      existing.predictive_best_rank = Math.min(existing.predictive_best_rank, index);
      byId.set(id, {
        ...existing,
        ...row,
        search_rank: existing.search_rank,
        predictive_score_components: existing.predictive_score_components,
        predictive_source_flags: existing.predictive_source_flags,
        predictive_best_rank: existing.predictive_best_rank,
      });
    });
  }
  return [...byId.values()]
    .map((row) => ({
      ...row,
      search_rank: Number(row.search_rank || 0) + scoreRow(row, query) * 80,
    }))
    .sort((left, right) =>
      Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
      Number(left.predictive_best_rank || 0) - Number(right.predictive_best_rank || 0) ||
      String(left.name || '').localeCompare(String(right.name || '')) ||
      String(left.card_number || '').localeCompare(String(right.card_number || '')))
    .slice(0, Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP));
}

function strictPredictivePoolError(failedSources, sourceResults) {
  if (!predictivePoolStrictMode()) return null;
  const fulfilledRows = sourceResults
    .filter((entry) => entry.source !== 'supabase_predicted_names')
    .filter((entry) => entry.status === 'fulfilled')
    .reduce((sum, entry) => sum + Number(entry.rowCount || 0), 0);
  if (failedSources.length === 0 && fulfilledRows > 0) return null;
  const error = new Error(failedSources.length > 0
    ? `Predictive pool source failed: ${failedSources.map((entry) => entry.source).join(', ')}`
    : 'Predictive pool returned no candidate rows.');
  error.statusCode = 503;
  error.code = 'PREDICTIVE_POOL_SOURCE_FAILED';
  error.predictivePool = {
    strict: true,
    failedSources,
    sources: sourceResults.map((entry) => ({
      source: entry.source,
      status: entry.status,
      reason: entry.reason,
      code: entry.code,
      rowCount: entry.rowCount,
      skipped: entry.skipped,
    })),
  };
  return error;
}

async function predictiveDimensionRowsWithDatabase(source, tokens, poolLimit, query) {
  const cleanPoolLimit = Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
  const sourceTokens = dimensionTokensForSource(source, tokens).slice(0, 6);
  if (sourceTokens.length === 0) return [];
  const normalizedTerms = [...new Set(sourceTokens.map((token) => token.term).filter(Boolean))];
  const compactTerms = [...new Set(sourceTokens.map((token) => compact(token.term)).filter(Boolean))];
  const variationTargets = [...new Set(sourceTokens
    .filter((token) => token.kind === 'variation')
    .flatMap((token) => variationTermTargets(token.term)))];
  const expansionTargets = [...new Set(sourceTokens
    .filter((token) => token.kind === 'expansion')
    .flatMap((token) => expansionAliasTargets(token.term)))];
  const result = await withTimeout(
    query(
      `
        with input as (
          select
            $1::text[] as normalized_terms,
            $2::text[] as compact_terms,
            $3::text[] as variation_targets,
            $4::text[] as expansion_targets,
            $5::text as source,
            least(greatest($6::integer, 1), 5000) as clean_limit
        )
        select
          c.card_id,
          c.name,
          c.set_name,
          candidate_number.card_number,
          c.product_variant,
          c.rarity,
          c.card_type,
          c.item_kind,
          c.product_type,
          c.trainer_name,
          c.canonical_name,
          c.image_url,
          c.cdn_image_url,
          c.preview_image_url,
          c.card_palette,
          c.emoji,
          c.imported_at,
          coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
          public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
          public.marketplace_search_compact(candidate_number.card_number) as compact_number,
          public.marketplace_search_normalize(c.set_name) as normalized_set,
          public.marketplace_search_compact(c.set_name) as compact_set,
          public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
          public.marketplace_search_compact(c.trainer_name) as compact_trainer,
          public.marketplace_search_normalize(c.product_variant) as normalized_variant,
          public.marketplace_search_compact(c.product_variant) as compact_variant,
          (
            case
              when input.source = 'number' and exists (
                select 1 from unnest(input.compact_terms) term
                where public.marketplace_search_compact(candidate_number.card_number) = term
                   or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
              ) then 3400
              when input.source = 'expansion' and exists (
                select 1 from unnest(input.expansion_targets) target
                where public.marketplace_search_compact(c.set_name) = target
                   or public.marketplace_search_compact(c.set_name) like target || '%'
                   or target like public.marketplace_search_compact(c.set_name) || '%'
              ) then 3200
              when input.source = 'expansion' and exists (
                select 1 from unnest(input.compact_terms) term
                where public.marketplace_search_compact(c.set_name) = term
                   or public.marketplace_search_compact(c.set_name) like term || '%'
              ) then 2200
              when input.source = 'rarity' and exists (
                select 1 from unnest(input.normalized_terms) term
                where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
              ) then 2100
              when input.source = 'variation_owner' and exists (
                select 1 from unnest(input.variation_targets) target
                where cv.variation_key = target
              ) then 3300
              when input.source = 'variation_owner' and exists (
                select 1 from unnest(input.compact_terms) term
                where public.marketplace_search_compact(c.trainer_name) = term
                   or public.marketplace_search_compact(c.trainer_name) like term || '%'
                   or public.marketplace_search_compact(c.product_variant) = term
                   or public.marketplace_search_compact(c.product_variant) like term || '%'
              ) then 2600
              else 0
            end +
            c.search_weight * 0.2
          )::real as search_rank
        from input
        join public.marketplace_search_candidates c on true
        ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
        left join public.marketplace_card_variations cv on cv.card_id = c.card_id
        where (
          input.source = 'number' and exists (
            select 1 from unnest(input.compact_terms) term
            where public.marketplace_search_compact(candidate_number.card_number) = term
               or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
          )
        ) or (
          input.source = 'expansion' and (
            exists (
              select 1 from unnest(input.expansion_targets) target
              where public.marketplace_search_compact(c.set_name) = target
                 or public.marketplace_search_compact(c.set_name) like target || '%'
                 or target like public.marketplace_search_compact(c.set_name) || '%'
            )
            or exists (
              select 1 from unnest(input.compact_terms) term
              where length(term) >= 3
                and (
                  public.marketplace_search_compact(c.set_name) = term
                  or public.marketplace_search_compact(c.set_name) like term || '%'
                )
            )
          )
        ) or (
          input.source = 'rarity' and exists (
            select 1 from unnest(input.normalized_terms) term
            where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
          )
        ) or (
          input.source = 'variation_owner' and (
            exists (
              select 1 from unnest(input.variation_targets) target
              where cv.variation_key = target
            )
            or exists (
              select 1 from unnest(input.compact_terms) term
              where length(term) >= 2
                and (
                  public.marketplace_search_compact(c.trainer_name) = term
                  or public.marketplace_search_compact(c.trainer_name) like term || '%'
                  or public.marketplace_search_compact(c.product_variant) = term
                  or public.marketplace_search_compact(c.product_variant) like term || '%'
                )
            )
          )
        )
        group by
          c.card_id,
          c.name,
          c.set_name,
          candidate_number.card_number,
          c.product_variant,
          c.rarity,
          c.card_type,
          c.item_kind,
          c.product_type,
          c.trainer_name,
          c.canonical_name,
          c.image_url,
          c.cdn_image_url,
          c.preview_image_url,
          c.card_palette,
          c.emoji,
          c.imported_at,
          c.search_weight,
          input.source
        having (
          case
            when input.source = 'variation_owner' and count(cv.variation_key) > 0 then true
            else true
          end
        )
        order by search_rank desc, c.name asc, candidate_number.card_number asc
        limit (select clean_limit from input)
      `,
      [normalizedTerms, compactTerms, variationTargets, expansionTargets, source, cleanPoolLimit],
    ),
    dimensionSearchTimeoutMs(),
    `predictive ${source} search`,
  );
  return result.rows;
}

function predictionDebugEntry(prediction) {
  const candidateCardIds = predictionCandidateCardIds(prediction, 32);
  return {
    normalized: prediction.normalized,
    display: prediction.display,
    confidence: prediction.confidence,
    score: prediction.score,
    source_rank: prediction.source_rank,
    language: prediction.language,
    representative_card_ids: candidateCardIds.slice(0, 8),
    ...(candidateCardIds.length > 0 ? { candidate_card_ids: candidateCardIds } : {}),
  };
}

async function candidateRowsForPredictedNames(
  predictions,
  poolLimit,
  query = marketplaceNameSearchQuery,
) {
  const representativeIds = [];
  const seenIds = new Set();
  for (const prediction of predictions || []) {
    for (const cardId of prediction.representative_card_ids || []) {
      const id = String(cardId || '').trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      representativeIds.push(id);
      if (representativeIds.length >= AUTOCOMPLETE_SQL_SAFE_POOL_CAP) break;
    }
    if (representativeIds.length >= AUTOCOMPLETE_SQL_SAFE_POOL_CAP) break;
  }
  if (representativeIds.length > 0) {
    return searchCandidatesForCardIdsWithDatabase(
      representativeIds.slice(0, Math.min(Math.max(poolLimit * SUPABASE_PREDICTED_NAME_TOKEN_LIMIT, 500), AUTOCOMPLETE_SQL_SAFE_POOL_CAP)),
      query,
    );
  }
  const canonicalNames = [...new Set((predictions || [])
    .map((prediction) => prediction.display)
    .filter(Boolean))]
    .slice(0, SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
  if (canonicalNames.length === 0) return [];
  return searchCandidatesForCanonicalNamesWithDatabase(
    canonicalNames,
    Math.min(Math.max(poolLimit * SUPABASE_PREDICTED_NAME_TOKEN_LIMIT, 500), AUTOCOMPLETE_SQL_SAFE_POOL_CAP),
    query,
  );
}

function scorePredictedNameCandidate(row, prediction, dimensionTokens) {
  let score = predictiveConfidenceBoost(prediction.confidence);
  let matchedDimensions = 0;
  const matchedSources = new Set(['name']);
  for (const token of dimensionTokens || []) {
    const tokenScore = fieldTokenScore(row, token);
    if (tokenScore <= 0) {
      return null;
    }
    score += tokenScore * 140;
    matchedDimensions += 1;
    if (token.kind === 'number') matchedSources.add('number');
    else if (token.kind === 'expansion' || token.sourceHint === 'expansion') matchedSources.add('expansion');
    else if (token.kind === 'rarity') matchedSources.add('rarity');
    else if (token.kind === 'variation' || token.sourceHint === 'variation_owner') matchedSources.add('variation_owner');
  }
  return {
    score,
    matchedDimensions,
    matchedSources: [...matchedSources],
  };
}

async function predictiveRowsForNamePredictions(
  predictionSets,
  poolLimit,
  query = marketplaceNameSearchQuery,
) {
  const uniquePredictions = new Map();
  for (const set of predictionSets || []) {
    for (const prediction of set.predictions || []) {
      const key = String(prediction.normalized || prediction.display || '');
      const existing = uniquePredictions.get(key);
      if (!existing || prediction.confidence > existing.confidence) {
        uniquePredictions.set(key, prediction);
      }
    }
  }
  const candidateRows = await candidateRowsForPredictedNames([...uniquePredictions.values()], poolLimit, query);
  const rows = [];
  for (const set of predictionSets || []) {
    for (const prediction of set.predictions || []) {
      for (const row of candidateRows) {
        const predictionIds = new Set((prediction.representative_card_ids || []).map((id) => String(id)));
        if (
          predictionIds.size > 0
            ? !predictionIds.has(String(row.card_id || ''))
            : compact(row.canonical_name || row.name) !== prediction.normalized
        ) continue;
        const scored = scorePredictedNameCandidate(row, prediction, set.dimensionTokens);
        if (!scored) continue;
        rows.push({
          ...row,
          search_rank: Number(row.search_rank || 0) + scored.score,
          predicted_name: predictionDebugEntry(prediction),
          predicted_name_confidence: prediction.confidence,
          predictive_dimension_match_count: scored.matchedDimensions,
          predictive_source_flags: scored.matchedSources,
          predictive_score_components: {
            predicted_name_confidence: predictiveConfidenceBoost(prediction.confidence),
            dimension_matches: scored.matchedDimensions * 180000,
          },
        });
      }
    }
  }
  return mergeRowsPreservingBest([rows], poolLimit);
}

async function predictiveVerifiedDimensionRowsWithDatabase(
  source,
  predictionSets,
  poolLimit,
  query,
) {
  const cleanPoolLimit = Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
  const rowGroups = [];
  for (const set of predictionSets || []) {
    const sourceTokens = dimensionTokensForSource(source, set.dimensionTokens).slice(0, 6);
    if (sourceTokens.length === 0 || !set.predictions?.length) continue;
    const canonicalNames = [...new Set(set.predictions.map((prediction) => prediction.display).filter(Boolean))]
      .slice(0, SUPABASE_PREDICTED_NAME_TOKEN_LIMIT);
    const candidateCardIds = [...new Set(set.predictions.flatMap((prediction) =>
      predictionCandidateCardIds(prediction, 64)))]
      .slice(0, AUTOCOMPLETE_SQL_SAFE_POOL_CAP);
    if (canonicalNames.length === 0 && candidateCardIds.length === 0) continue;
    const predictionByName = new Map(set.predictions.map((prediction) => [
      compact(prediction.display),
      prediction,
    ]));
    const predictionByCardId = new Map();
    for (const prediction of set.predictions) {
      for (const id of predictionCandidateCardIds(prediction, 64)) {
        if (!predictionByCardId.has(id)) {
          predictionByCardId.set(id, prediction);
        }
      }
    }
    const normalizedTerms = [...new Set(sourceTokens.map((token) => token.term).filter(Boolean))];
    const compactTerms = [...new Set(sourceTokens.map((token) => compact(token.term)).filter(Boolean))];
    const variationTargets = [...new Set(sourceTokens
      .filter((token) => token.kind === 'variation')
      .flatMap((token) => variationTermTargets(token.term)))];
    const expansionTargets = [...new Set(sourceTokens
      .filter((token) => token.kind === 'expansion')
      .flatMap((token) => expansionAliasTargets(token.term)))];
    const result = await withTimeout(
      query(
        `
          with input as (
            select
              $1::text[] as canonical_names,
              $2::text[] as normalized_terms,
              $3::text[] as compact_terms,
              $4::text[] as variation_targets,
              $5::text[] as expansion_targets,
              $6::text as source,
              least(greatest($7::integer, 1), 5000) as clean_limit,
              $8::bigint[] as candidate_card_ids
          )
          select
            c.card_id,
            c.name,
            c.set_name,
            candidate_number.card_number,
            c.product_variant,
            c.rarity,
            c.card_type,
            c.item_kind,
            c.product_type,
            c.trainer_name,
            c.canonical_name,
            c.image_url,
            c.cdn_image_url,
            c.preview_image_url,
            c.card_palette,
            c.emoji,
            c.imported_at,
            coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
            public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
            public.marketplace_search_compact(candidate_number.card_number) as compact_number,
            public.marketplace_search_normalize(c.set_name) as normalized_set,
            public.marketplace_search_compact(c.set_name) as compact_set,
            public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
            public.marketplace_search_compact(c.trainer_name) as compact_trainer,
            public.marketplace_search_normalize(c.product_variant) as normalized_variant,
            public.marketplace_search_compact(c.product_variant) as compact_variant,
            (
              case
                when input.source = 'number' and exists (
                  select 1 from unnest(input.compact_terms) term
                  where public.marketplace_search_compact(candidate_number.card_number) = term
                     or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
                ) then 3600
                when input.source = 'expansion' and exists (
                  select 1 from unnest(input.expansion_targets) target
                  where public.marketplace_search_compact(c.set_name) = target
                     or public.marketplace_search_compact(c.set_name) like target || '%'
                     or target like public.marketplace_search_compact(c.set_name) || '%'
                ) then 3300
                when input.source = 'expansion' and exists (
                  select 1 from unnest(input.compact_terms) term
                  where public.marketplace_search_compact(c.set_name) = term
                     or public.marketplace_search_compact(c.set_name) like term || '%'
                ) then 2600
                when input.source = 'rarity' and exists (
                  select 1 from unnest(input.normalized_terms) term
                  where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
                ) then 2400
                when input.source = 'variation_owner' and exists (
                  select 1 from unnest(input.variation_targets) target
                  where cv.variation_key = target
                ) then 3500
                when input.source = 'variation_owner' and exists (
                  select 1 from unnest(input.compact_terms) term
                  where public.marketplace_search_compact(c.trainer_name) = term
                     or public.marketplace_search_compact(c.trainer_name) like term || '%'
                     or public.marketplace_search_compact(c.product_variant) = term
                     or public.marketplace_search_compact(c.product_variant) like term || '%'
                ) then 2800
                else 0
              end +
              c.search_weight * 0.25
            )::real as search_rank
          from input
          join public.marketplace_search_candidates c
            on (
              case
                when cardinality(input.candidate_card_ids) > 0
                  then c.card_id = any(input.candidate_card_ids)
                else coalesce(nullif(c.canonical_name, ''), c.name) = any(input.canonical_names)
              end
            )
          ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
          left join public.marketplace_card_variations cv on cv.card_id = c.card_id
          where (
            input.source = 'number' and exists (
              select 1 from unnest(input.compact_terms) term
              where public.marketplace_search_compact(candidate_number.card_number) = term
                 or public.marketplace_search_compact(candidate_number.card_number) like '%' || term || '%'
            )
          ) or (
            input.source = 'expansion' and (
              exists (
                select 1 from unnest(input.expansion_targets) target
                where public.marketplace_search_compact(c.set_name) = target
                   or public.marketplace_search_compact(c.set_name) like target || '%'
                   or target like public.marketplace_search_compact(c.set_name) || '%'
              )
              or exists (
                select 1 from unnest(input.compact_terms) term
                where length(term) >= 3
                  and (
                    public.marketplace_search_compact(c.set_name) = term
                    or public.marketplace_search_compact(c.set_name) like term || '%'
                  )
              )
            )
          ) or (
            input.source = 'rarity' and exists (
              select 1 from unnest(input.normalized_terms) term
              where public.marketplace_search_normalize(concat_ws(' ', c.rarity, candidate_number.card_number)) like '%' || term || '%'
            )
          ) or (
            input.source = 'variation_owner' and (
              exists (
                select 1 from unnest(input.variation_targets) target
                where cv.variation_key = target
              )
              or exists (
                select 1 from unnest(input.compact_terms) term
                where length(term) >= 2
                  and (
                    public.marketplace_search_compact(c.trainer_name) = term
                    or public.marketplace_search_compact(c.trainer_name) like term || '%'
                    or public.marketplace_search_compact(c.product_variant) = term
                    or public.marketplace_search_compact(c.product_variant) like term || '%'
                  )
              )
            )
          )
          group by
            c.card_id,
            c.name,
            c.set_name,
            candidate_number.card_number,
            c.product_variant,
            c.rarity,
            c.card_type,
            c.item_kind,
            c.product_type,
            c.trainer_name,
            c.canonical_name,
            c.image_url,
            c.cdn_image_url,
            c.preview_image_url,
            c.card_palette,
            c.emoji,
            c.imported_at,
            c.search_weight,
            input.source
          order by search_rank desc, c.name asc, candidate_number.card_number asc
          limit (select clean_limit from input)
        `,
        [
          canonicalNames,
          normalizedTerms,
          compactTerms,
          variationTargets,
          expansionTargets,
          source,
          cleanPoolLimit,
          candidateCardIds,
        ],
      ),
      dimensionSearchTimeoutMs(),
      `predictive ${source} verification`,
    );
    rowGroups.push(result.rows.map((row) => {
      const prediction = predictionByCardId.get(String(row.card_id || '')) ||
        predictionByName.get(compact(row.canonical_name || row.name));
      return {
        ...row,
        predicted_name: prediction ? predictionDebugEntry(prediction) : null,
        predicted_name_confidence: prediction?.confidence || 0,
        predictive_dimension_match_count: sourceTokens.length,
        predictive_source_flags: ['name', source],
      };
    }));
  }
  return mergeRowsPreservingBest(rowGroups, cleanPoolLimit);
}

async function predictedNamePredictionSets(plan, searchLanguage, debug, nameIndexQuery) {
  const candidates = plan.nameFragmentCandidates.length > 0
    ? plan.nameFragmentCandidates
    : [{
        nameFragment: plan.textTokens.map((token) => token.term).join(' '),
        nameTerms: plan.textTokens.map((token) => token.term),
        dimensionTokens: plan.dimensionTokens,
        reason: 'text_tokens',
      }];
  const predictionSets = [];
  for (const candidate of candidates) {
    if (!candidate.nameFragment) continue;
    const predictions = await predictedNameTokensFromSupabase(
      candidate.nameFragment,
      searchLanguage,
      debug,
      nameIndexQuery,
      { strict: true },
    );
    if (predictions.length === 0) continue;
    predictionSets.push({
      ...candidate,
      predictions,
    });
  }
  return predictionSets;
}

async function buildPredictivePoolWithFanout(
  searchTerm,
  poolLimit,
  searchLanguage,
  previousContext,
  debug,
  nameIndexQuery = supabaseNameIndexQuery,
  predictionContext = null,
) {
  const plan = predictivePoolPlan(searchTerm);
  if (!plan) return null;
  const started = Date.now();
  const strict = predictivePoolStrictMode();
  const predictionRoute = {
    source: 'supabase_predicted_names',
    configured: supabasePredictionConfigured(),
    fallbackToPrimary: !supabasePredictionConfigured(),
  };
  const predictionTaskStarted = Date.now();
  let predictionSets = [];
  let predictionSourceResult;
  const contextPredictionSets = predictionSetsFromContext(
    plan,
    predictionContext,
    searchTerm,
    searchLanguage,
    debug,
  );
  const firstNameAnchor = await firstNameAnchorForPredictivePlan(
    plan,
    searchLanguage,
    debug,
    nameIndexQuery,
    predictionContext,
  );
  const anchorPredictionSets = anchoredPredictionSets(firstNameAnchor, plan.tokens);
  if (strict && predictionRoute.fallbackToPrimary && plan.textTokens.length > 0 && !contextPredictionSets && !anchorPredictionSets) {
    predictionSourceResult = {
      source: 'supabase_predicted_names',
      status: 'failed',
      reason: 'source_not_configured_no_primary_fallback',
      route: predictionRoute,
      rowCount: 0,
      rows: [],
      durationMs: Date.now() - predictionTaskStarted,
    };
  } else {
    try {
      predictionSets = anchorPredictionSets ||
        contextPredictionSets ||
        (plan.textTokens.length > 0
          ? await predictedNamePredictionSets(plan, searchLanguage, debug, nameIndexQuery)
          : []);
      predictionSourceResult = {
        source: 'supabase_predicted_names',
        status: predictionSets.length > 0 || plan.textTokens.length === 0 ? 'fulfilled' : 'failed',
        reason: predictionSets.length > 0 || plan.textTokens.length === 0 ? undefined : 'empty_prediction_sets',
        route: predictionRoute,
        rowCount: predictionSets.reduce((sum, set) => sum + set.predictions.length, 0),
        rows: [],
        contextProvided: Boolean(contextPredictionSets),
        firstNameAnchorProvided: Boolean(anchorPredictionSets),
        durationMs: Date.now() - predictionTaskStarted,
      };
    } catch (error) {
      predictionSourceResult = {
        source: 'supabase_predicted_names',
        status: 'failed',
        reason: error.message || String(error),
        code: error.code,
        route: predictionRoute,
        rowCount: 0,
        rows: [],
        contextProvided: Boolean(contextPredictionSets),
        firstNameAnchorProvided: Boolean(anchorPredictionSets),
        durationMs: Date.now() - predictionTaskStarted,
      };
    }
  }
  const nameRoute = {
    source: 'name',
    configured: marketplaceNameSearchDatabaseUrl() !== marketplaceDatabaseUrl(),
    fallbackToPrimary: marketplaceNameSearchDatabaseUrl() === marketplaceDatabaseUrl(),
  };
  const sourceTasks = [
    {
      source: 'name',
      route: nameRoute,
      required: plan.textTokens.length > 0 || plan.dimensionTokens.length === 0,
      run: () => predictiveRowsForNamePredictions(
        predictionSets,
        poolLimit,
        marketplaceNameSearchQuery,
      ),
    },
    ...PREDICTIVE_DIMENSION_SOURCES.map((source) => {
      const route = marketplaceDimensionSearchRoute(source);
      const hasMatchingToken = predictionSets.length > 0
        ? predictionSets.some((set) => dimensionTokensForSource(source, set.dimensionTokens).length > 0)
        : dimensionTokensForSource(source, plan.dimensionTokens).length > 0;
      return {
        source,
        route,
        required: hasMatchingToken,
        run: () => predictionSets.length > 0
          ? predictiveVerifiedDimensionRowsWithDatabase(
            source,
            predictionSets,
            poolLimit,
            (sql, values) => marketplaceDimensionSearchQuery(source, sql, values),
          )
          : predictiveDimensionRowsWithDatabase(
            source,
            plan.tokens,
            poolLimit,
            (sql, values) => marketplaceDimensionSearchQuery(source, sql, values),
          ),
      };
    }),
  ];
  const predictionFailed = predictionSourceResult.status === 'failed' && plan.textTokens.length > 0;
  const preflightResults = sourceTasks.map((task) => {
    if (strict && task.route?.fallbackToPrimary) {
      return {
        source: task.source,
        status: task.required ? 'failed' : 'skipped',
        skipped: !task.required,
        reason: 'source_not_configured_no_primary_fallback',
        route: task.route,
        rowCount: 0,
        rows: [],
        durationMs: 0,
      };
    }
    if (!task.required && task.source !== 'name' && !task.route?.configured) {
      return {
        source: task.source,
        status: 'skipped',
        skipped: true,
        reason: 'source_not_required_or_configured',
        route: task.route,
        rowCount: 0,
        rows: [],
        durationMs: 0,
      };
    }
    return null;
  });
  const preflightFailures = [
    ...(predictionFailed && strict ? [predictionSourceResult] : []),
    ...preflightResults.filter((entry) => entry?.status === 'failed'),
  ];
  if (preflightFailures.length > 0) {
    const sourceResults = [
      predictionSourceResult,
      ...sourceTasks.map((task, index) =>
      preflightResults[index] || {
        source: task.source,
        status: 'not_started',
        route: task.route,
        rowCount: 0,
        rows: [],
        durationMs: 0,
      }),
    ];
    if (debug) {
      debug.searchPath = 'predictive_dimension_pool';
      debug.predictivePool = {
        strategy: 'predictive_dimension_pool',
        model: 'dynamic_supabase_predicted_tokens',
        strict,
        tokens: plan.tokens,
        nameFragmentCandidates: plan.nameFragmentCandidates,
        firstNameAnchor: firstNameAnchor
          ? {
              nameFragment: firstNameAnchor.nameFragment,
              source: firstNameAnchor.source,
              predictionCount: firstNameAnchor.predictions.length,
            }
          : null,
        predictedTokens: predictionSets.flatMap((set) =>
          set.predictions.map((prediction) => ({
            ...predictionDebugEntry(prediction),
            nameFragment: set.nameFragment,
            remainingTokens: set.dimensionTokens,
          }))),
        sources: sourceResults.map((entry) => ({
          source: entry.source,
          status: entry.status,
          skipped: Boolean(entry.skipped),
          reason: entry.reason,
          code: entry.code,
          route: entry.route,
          rowCount: entry.rowCount,
          contextProvided: Boolean(entry.contextProvided),
          firstNameAnchorProvided: Boolean(entry.firstNameAnchorProvided),
          durationMs: entry.durationMs,
        })),
        failedSourceCount: preflightFailures.length,
        durationMs: Date.now() - started,
      };
    }
    throw strictPredictivePoolError(preflightFailures, sourceResults);
  }
  const sourceResults = await Promise.all(sourceTasks.map(async (task) => {
    const taskStarted = Date.now();
    if (strict && task.route?.fallbackToPrimary) {
      return {
        source: task.source,
        status: task.required ? 'failed' : 'skipped',
        skipped: !task.required,
        reason: 'source_not_configured_no_primary_fallback',
        route: task.route,
        rowCount: 0,
        rows: [],
        durationMs: Date.now() - taskStarted,
      };
    }
    if (!task.required && task.source !== 'name' && !task.route?.configured) {
      return {
        source: task.source,
        status: 'skipped',
        skipped: true,
        reason: 'source_not_required_or_configured',
        route: task.route,
        rowCount: 0,
        rows: [],
        durationMs: Date.now() - taskStarted,
      };
    }
    try {
      const rows = await task.run();
      return {
        source: task.source,
        status: 'fulfilled',
        route: task.route,
        rowCount: rows.length,
        rows,
        durationMs: Date.now() - taskStarted,
      };
    } catch (error) {
      return {
        source: task.source,
        status: 'failed',
        reason: error.message || String(error),
        code: error.code,
        route: task.route,
        rowCount: 0,
        rows: [],
        durationMs: Date.now() - taskStarted,
      };
    }
  }));
  const allSourceResults = [predictionSourceResult, ...sourceResults];
  const failedSources = allSourceResults.filter((entry) => entry.status === 'failed');
  if (debug) {
    debug.searchPath = 'predictive_dimension_pool';
    debug.predictivePool = {
      strategy: 'predictive_dimension_pool',
      model: 'dynamic_supabase_predicted_tokens',
      strict,
      tokens: plan.tokens,
      nameFragmentCandidates: plan.nameFragmentCandidates,
      firstNameAnchor: firstNameAnchor
        ? {
            nameFragment: firstNameAnchor.nameFragment,
            source: firstNameAnchor.source,
            predictionCount: firstNameAnchor.predictions.length,
          }
        : null,
      predictedTokens: predictionSets.flatMap((set) =>
        set.predictions.map((prediction) => ({
          ...predictionDebugEntry(prediction),
          nameFragment: set.nameFragment,
          remainingTokens: set.dimensionTokens,
        }))),
      sources: allSourceResults.map((entry) => ({
        source: entry.source,
        status: entry.status,
        skipped: Boolean(entry.skipped),
        reason: entry.reason,
        code: entry.code,
        route: entry.route,
        rowCount: entry.rowCount,
        contextProvided: Boolean(entry.contextProvided),
        firstNameAnchorProvided: Boolean(entry.firstNameAnchorProvided),
        durationMs: entry.durationMs,
      })),
      failedSourceCount: failedSources.length,
      durationMs: Date.now() - started,
    };
  }
  const strictError = strictPredictivePoolError(failedSources, allSourceResults);
  if (strictError) throw strictError;
  const rows = mergePredictivePoolRows(sourceResults, searchTerm, poolLimit);
  if (sourceResults.some((entry) => entry.status === 'fulfilled') && rows.length === 0) {
    const emptyError = new Error('Predictive pool returned no rankable candidate rows.');
    emptyError.statusCode = 503;
    emptyError.code = 'PREDICTIVE_POOL_EMPTY_AFTER_MERGE';
    emptyError.predictivePool = {
      strict,
      sources: allSourceResults.map((entry) => ({
        source: entry.source,
        status: entry.status,
        reason: entry.reason,
        code: entry.code,
        rowCount: entry.rowCount,
        skipped: entry.skipped,
        contextProvided: Boolean(entry.contextProvided),
        firstNameAnchorProvided: Boolean(entry.firstNameAnchorProvided),
      })),
    };
    throw emptyError;
  }
  rows.nonNameContext = {
    predictive_pool: {
      strict,
      predicted_tokens: predictionSets.flatMap((set) =>
        set.predictions.map((prediction) => ({
          ...predictionDebugEntry(prediction),
          name_fragment: set.nameFragment,
          remaining_tokens: set.dimensionTokens,
        }))),
      sources: allSourceResults.map((entry) => ({
        source: entry.source,
        status: entry.status,
        row_count: entry.rowCount,
        context_provided: Boolean(entry.contextProvided),
        first_name_anchor_provided: Boolean(entry.firstNameAnchorProvided),
      })),
    },
  };
  if (debug?.predictivePool) {
    debug.predictivePool.mergedRowCount = rows.length;
    debug.predictivePool.mergedTopSources = rows.slice(0, 12).map((row) => ({
      card_id: row.card_id,
      sources: sourceFlagsFor(row),
      components: row.predictive_score_components,
    }));
    debug.tokenPlan = {
      strategy: 'predictive_dimension_pool',
      tokens: plan.tokens,
      predictedTokenCount: predictionSets.reduce((sum, set) => sum + set.predictions.length, 0),
      sourceCount: sourceResults.length,
      failedSourceCount: failedSources.length,
      matchedRowCount: rows.length,
      durationMs: Date.now() - started,
    };
  }
  return rows.length > 0 ? rows : null;
}

function rowNameTokenScore(row, token) {
  const name = String(row.canonical_name || row.name || '').toLowerCase();
  const nameWords = searchTerms(name);
  return nameTokenConfidence(name, nameWords, token.term);
}

function scoreRowAgainstFanoutPlan(row, plan) {
  const nameTokenScores = plan.tokens
    .filter((token) => token.kind === 'text' || token.kind === 'expansion')
    .map((token) => ({
      token,
      score: rowNameTokenScore(row, token),
    }));
  const bestNameToken = nameTokenScores
    .filter((entry) => entry.score >= 60)
    .sort((left, right) => right.score - left.score)[0];
  if (!bestNameToken) {
    return { matched: false, score: 0 };
  }
  const fieldTokens = [
    ...plan.tokens.filter((token) => token.term !== bestNameToken.token.term),
  ];
  let fieldScore = 0;
  for (const token of fieldTokens) {
    const score = fieldTokenScore(row, token);
    if (score <= 0) {
      return { matched: false, score: 0 };
    }
    fieldScore += score;
  }
  return {
    matched: true,
    score: bestNameToken.score * 14 + fieldScore + Number(row.search_rank || 0),
  };
}

async function searchStructuredAutocompleteWithContext(
  searchTerm,
  poolLimit,
  searchLanguage,
  previousContext,
  debug,
  query = marketplaceQuery,
) {
  const context = cleanSearchContext(previousContext, searchTerm, searchLanguage);
  if (!context.valid) {
    if (debug) {
      debug.contextRefine = { used: false, reason: context.reason };
    }
    return null;
  }
  const plan = candidateFanoutPlan(searchTerm);
  if (!plan) {
    if (debug) {
      debug.contextRefine = { used: false, reason: 'no_fanout_plan' };
    }
    return null;
  }
  const started = Date.now();
  const candidateRows = await searchCandidatesForCardIdsWithDatabase(context.cardIds, query);
  const ranked = [];
  for (const row of candidateRows) {
    const result = scoreRowAgainstFanoutPlan(row, plan);
    if (!result.matched) continue;
    ranked.push({
      ...row,
      search_rank: result.score,
    });
  }
  ranked.sort((left, right) =>
    Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
    String(left.name || '').localeCompare(String(right.name || '')) ||
    String(left.card_number || '').localeCompare(String(right.card_number || '')));
  if (debug) {
    debug.tokenPlan = {
      strategy: 'candidate_context_refine',
      tokens: plan.tokens,
      previousQuery: context.query,
      previousCardIdCount: context.cardIds.length,
      candidateRowCount: candidateRows.length,
      matchedRowCount: ranked.length,
      durationMs: Date.now() - started,
    };
  }
  if (ranked.length === 0) {
    const previousTerms = new Set(searchTerms(context.query));
    const addedNameTokens = plan.nameProbeTokens.filter((token) => !previousTerms.has(token.term));
    for (const seedToken of addedNameTokens) {
      const entities = await searchCanonicalNameEntitiesWithDatabase(seedToken.term, 20, searchLanguage, query);
      if (entities.length === 0) continue;
      const namesByScore = new Map();
      for (const entity of entities) {
        namesByScore.set(entity.name, Math.max(
          Number(namesByScore.get(entity.name) || 0),
          Number(entity.token_score || 0),
        ));
      }
      const canonicalNames = [...namesByScore.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 30)
        .map(([name]) => name);
      const seededRows = await searchCandidatesForCanonicalNamesWithDatabase(
        canonicalNames,
        Math.min(Math.max(poolLimit * 40, 500), 4000),
        query,
      );
      const previousFieldTokens = plan.tokens.filter((token) => token.term !== seedToken.term);
      const seededRanked = [];
      for (const row of seededRows) {
        let fieldScore = 0;
        let matched = true;
        for (const token of previousFieldTokens) {
          const score = fieldTokenScore(row, token);
          if (score <= 0) {
            matched = false;
            break;
          }
          fieldScore += score;
        }
        if (!matched) continue;
        seededRanked.push({
          ...row,
          search_rank: Number(namesByScore.get(row.canonical_name || row.name) || 1000) +
            fieldScore +
            Number(row.search_rank || 0),
        });
      }
      seededRanked.sort((left, right) =>
        Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
        String(left.name || '').localeCompare(String(right.name || '')) ||
        String(left.card_number || '').localeCompare(String(right.card_number || '')));
      if (seededRanked.length > 0) {
        if (debug) {
          debug.tokenPlan = {
            strategy: 'candidate_context_refine',
            subStrategy: 'added_name_seed',
            tokens: plan.tokens,
            previousQuery: context.query,
            seedToken,
            previousCardIdCount: context.cardIds.length,
            candidateRowCount: seededRows.length,
            matchedRowCount: seededRanked.length,
            durationMs: Date.now() - started,
          };
        }
        return seededRanked.slice(0, poolLimit);
      }
    }
    if (debug) {
      debug.contextRefine = {
        used: true,
        fallbackReason: 'empty_context_refine',
        previousCardIdCount: context.cardIds.length,
      };
    }
    return null;
  }
  return ranked.slice(0, poolLimit);
}

function nameSeedCombinations(nameEntityGroups, maxGroups = 12) {
  return nameEntityGroups
    .filter((entry) => entry.entities.length > 0)
    .map((entry) => ({
      matchedNameTokens: [entry],
      fieldTokens: nameEntityGroups
        .filter((candidate) => candidate.term !== entry.term)
        .map((candidate) => ({ term: candidate.term, kind: 'text' })),
      score: Math.max(...entry.entities.map((entity) => Number(entity.token_score || 0))) + entry.term.length,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, maxGroups);
}

async function searchStructuredAutocompleteWithCandidateFanout(
  searchTerm,
  poolLimit,
  searchLanguage,
  debug,
  query = marketplaceQuery,
) {
  const plan = candidateFanoutPlan(searchTerm);
  if (!plan) return null;
  const nameStarted = Date.now();
  const nameEntityGroups = await Promise.all(plan.nameProbeTokens.map(async (token) => ({
    ...token,
    entities: await searchCanonicalNameEntitiesWithDatabase(token.term, 20, searchLanguage, query),
  })));
  const matchedNameTokens = nameEntityGroups.filter((entry) => entry.entities.length > 0);
  const nameDurationMs = Date.now() - nameStarted;
  if (matchedNameTokens.length === 0) return null;
  const combinations = nameSeedCombinations(nameEntityGroups);
  const candidateStarted = Date.now();
  const combinationResults = await Promise.all(combinations.map(async (combination) => {
    const fieldTokens = [
      ...combination.fieldTokens,
      ...plan.tokens.filter((token) => !nameEntityGroups.some((entry) => entry.term === token.term)),
    ];
    if (fieldTokens.length === 0) return null;
    const namesByScore = new Map();
    for (const entry of combination.matchedNameTokens) {
      for (const entity of entry.entities) {
        const current = namesByScore.get(entity.name) || 0;
        namesByScore.set(entity.name, Math.max(current, Number(entity.token_score || 0)));
      }
    }
    const canonicalNames = [...namesByScore.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 30)
      .map(([name]) => name);
    const candidateRows = await searchCandidatesForCanonicalNamesWithDatabase(
      canonicalNames,
      Math.min(Math.max(poolLimit * 40, 500), 4000),
      query,
    );
    const ranked = [];
    for (const row of candidateRows) {
      let fieldScore = 0;
      let matched = true;
      for (const token of fieldTokens) {
        const score = fieldTokenScore(row, token);
        if (score <= 0) {
          matched = false;
          break;
        }
        fieldScore += score;
      }
      if (!matched) continue;
      const nameScore = Number(namesByScore.get(row.canonical_name || row.name) || 1000);
      ranked.push({
        ...row,
        search_rank: nameScore + fieldScore + Number(row.search_rank || 0),
      });
    }
    ranked.sort((left, right) =>
      Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
      String(left.name || '').localeCompare(String(right.name || '')) ||
      String(left.card_number || '').localeCompare(String(right.card_number || '')));
    const result = {
      ranked,
      matchedNameTokens: combination.matchedNameTokens,
      fieldTokens,
      canonicalNames,
      candidateRowCount: candidateRows.length,
    };
    return result;
  }));
  const bestResult = combinationResults
    .filter(Boolean)
    .sort((left, right) =>
      (right.ranked.length > 0 ? 1 : 0) - (left.ranked.length > 0 ? 1 : 0) ||
      right.ranked.length - left.ranked.length ||
      Number(right.ranked[0]?.search_rank || 0) - Number(left.ranked[0]?.search_rank || 0))[0] || null;
  if (debug) {
    debug.tokenPlan = {
      strategy: 'candidate_fanout',
      tokens: plan.tokens,
      matchedNameTokens: (bestResult?.matchedNameTokens || matchedNameTokens).map((entry) => ({
        term: entry.term,
        entityCount: entry.entities.length,
        topEntities: entry.entities.slice(0, 6).map((entity) => entity.name),
      })),
      fieldTokens: bestResult?.fieldTokens || [],
      canonicalNameCount: bestResult?.canonicalNames?.length || 0,
      candidateRowCount: bestResult?.candidateRowCount || 0,
      matchedRowCount: bestResult?.ranked?.length || 0,
      nameDurationMs,
      candidateDurationMs: Date.now() - candidateStarted,
    };
  }
  return bestResult?.ranked?.length > 0 ? bestResult.ranked.slice(0, poolLimit) : null;
}

async function searchGenericEnergyExpansionRowsWithDatabase(
  searchTerm,
  poolLimit,
  debug,
  query = marketplaceQuery,
) {
  const plan = genericEnergyExpansionPlan(searchTerm);
  if (!plan) return null;
  const started = Date.now();
  const expansionTargets = [...new Set(plan.expansionTokens
    .flatMap((token) => expansionAliasTargets(token.term)))];
  if (expansionTargets.length === 0) return null;
  const result = await query(
    `
      with input as (
        select
          $1::text[] as expansion_targets,
          least(greatest($2::integer, 1), 5000) as clean_limit
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        (
          case
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) in (
              'grassenergy',
              'fireenergy',
              'waterenergy',
              'lightningenergy',
              'psychicenergy',
              'fightingenergy',
              'darknessenergy',
              'metalenergy'
            ) then 7200
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like '%energy' then 5600
            else 0
          end +
          case
            when public.marketplace_search_compact(c.set_name) = any(input.expansion_targets) then 1600
            else 900
          end +
          c.search_weight
        )::real as search_rank
      from input
      join public.marketplace_search_candidates c
        on public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like '%energy'
        and exists (
          select 1
          from unnest(input.expansion_targets) target
          where public.marketplace_search_compact(c.set_name) = target
             or public.marketplace_search_compact(c.set_name) like target || '%'
             or target like public.marketplace_search_compact(c.set_name) || '%'
        )
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like '%energy'
        and c.item_kind <> 'product'
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight,
        input.expansion_targets
      order by search_rank desc, c.name asc, candidate_number.card_number asc
      limit (select clean_limit from input)
    `,
    [expansionTargets, Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP)],
  );
  if (debug) {
    debug.genericEnergyExpansion = {
      used: true,
      strategy: plan.strategy,
      expansionTargets,
      candidateRowCount: result.rows.length,
      durationMs: Date.now() - started,
    };
  }
  return result.rows;
}

function mergeRowsPreservingBest(rowGroups, resultLimit) {
  const byId = new Map();
  for (const rows of rowGroups) {
    for (const row of rows || []) {
      const id = String(row.card_id || '');
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing || Number(row.search_rank || 0) > Number(existing.search_rank || 0)) {
        byId.set(id, row);
      }
    }
  }
  return [...byId.values()]
    .sort((left, right) => {
      const scoreDiff = Number(right.search_rank || 0) - Number(left.search_rank || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(left.name || '').localeCompare(String(right.name || '')) ||
        String(left.card_number || '').localeCompare(String(right.card_number || ''));
    })
    .slice(0, resultLimit);
}

function shardLabelForBucket(initial, bucket) {
  if (bucket.kind === 'range') {
    return `${initial}${bucket.start}-${initial}${bucket.end}`;
  }
  return `${initial}+numeric_special_diacritic_apostrophe_hyphen_space`;
}

function distributePrefixShardBuckets(clients, buckets = PREFIX_SHARD_SECONDARY_BUCKETS) {
  const activeClients = (clients || []).filter(Boolean);
  const clientCount = Math.max(activeClients.length, 1);
  const shardCount = Math.min(clientCount, buckets.length);
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    client: activeClients[index] || null,
    buckets: [],
  }));
  buckets.forEach((bucket, index) => {
    shards[index % shardCount].buckets.push(bucket);
  });
  return shards;
}

function oneCharacterPrefixShardPlan(searchTerm, clients = getMarketplacePrefixSearchClients()) {
  const compactTerm = compact(searchTerm);
  if (compactTerm.length !== 1) return [];
  return distributePrefixShardBuckets(clients).map((entry, index) => ({
    index,
    client: entry.client,
    buckets: entry.buckets,
    role: entry.client?.role || 'primary',
    label: entry.buckets.map((bucket) => shardLabelForBucket(compactTerm, bucket)).join(','),
  }));
}

function rowKey(row) {
  return String(row.card_id || row.blueprint_id || row.id || '');
}

async function filterRowsByStoredStructuredTokens(
  rows,
  structuredTokens,
  query = marketplaceQuery,
) {
  if (!rows.length || !structuredTokens.length) {
    return rows;
  }
  const ids = rows
    .map((row) => Number(row.card_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) {
    return [];
  }
  const variationTokens = structuredTokens
    .filter((token) => token.kind === 'variation')
    .map((token) => variationTermTargets(token.term));
  const expansionTokens = structuredTokens
    .filter((token) => token.kind === 'expansion')
    .flatMap((token) => expansionAliasTargets(token.term));
  const numberTokens = structuredTokens
    .filter((token) => token.kind === 'number')
    .map((token) => compact(token.term));

  const result = await query(
    `
      select
        c.card_id,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_compact(c.set_name) as compact_set
      from public.marketplace_search_candidates c
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      where c.card_id = any($1::bigint[])
      group by c.card_id, candidate_number.card_number, c.set_name
    `,
    [ids],
  );
  const facetsById = new Map(result.rows.map((row) => [String(row.card_id), row]));
  return rows.filter((row) => {
    const facets = facetsById.get(String(row.card_id));
    if (!facets) return false;
    const variationKeys = new Set(facets.variation_keys || []);
    const hasVariations = variationTokens.every((targets) =>
      targets.some((token) => variationKeys.has(token)));
    const normalizedNumberTerms = searchTerms(String(facets.normalized_number || ''));
    const compactNumber = String(facets.compact_number || '');
    const hasNumbers = numberTokens.every((token) =>
      normalizedNumberTerms.includes(token) ||
      compactNumber === token ||
      compactNumber.startsWith(token) ||
      compactNumber.includes(token));
    const compactSet = String(facets.compact_set || '');
    const hasExpansions = expansionTokens.every((token) =>
      compactSet === token || compactSet.startsWith(token) || token.startsWith(compactSet));
    return hasVariations && hasNumbers && hasExpansions;
  });
}

async function searchPredictiveNgramRowsWithDatabase(
  searchTerm,
  poolLimit,
  searchLanguage = 'en',
  debug = null,
  query = marketplaceNameSearchQuery,
  fallbackQuery = marketplaceQuery,
) {
  const chunks = predictiveChunksForQuery(searchTerm);
  if (chunks.length === 0) return null;
  const terms = searchTerms(searchTerm);
  const hasStructuredToken = terms.some((term) =>
    /^[0-9]+$/.test(term) ||
    isVariationIntentTerm(term) ||
    isRarityTerm(term) ||
    isExpansionAliasTerm(term));
  const ngramLanguage = cleanLanguage(searchLanguage);
  const values = [
    chunks.map((entry) => entry.chunk),
    Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_SQL_SAFE_POOL_CAP),
    ngramLanguage,
  ];
  const sql = `
      with query_chunks as (
        select
          chunk,
          ordinality::integer as chunk_order
        from unnest($1::text[]) with ordinality as input(chunk, ordinality)
      ),
      -- Predictive chunks and chunk-frequency boosts are language-local. Missing
      -- event rows produce a neutral boost instead of falling back to English.
      chunk_hits as (
        select
          n.card_id,
          max(n.name) as matched_name,
          count(distinct q.chunk)::integer as matched_chunks,
          sum(
            (
              case
                when n.chunk = q.chunk and n.is_prefix then 760
                when n.chunk = q.chunk then 520
                else 0
              end +
              greatest(0, 80 - n.chunk_position * 6) +
              n.source_weight * 100 +
              least(coalesce(e.total_weight, 0), 250) * 0.8
            )
          )::real as ngram_score,
          jsonb_agg(distinct n.chunk order by n.chunk) as matched_ngram_chunks
        from query_chunks q
        join public.marketplace_name_ngrams n
          on n.language = $3::text
          and n.chunk = q.chunk
        left join public.marketplace_query_chunk_events e
          on e.language = $3::text
          and e.chunk = q.chunk
          and e.event_type = 'search'
        group by n.card_id
        having count(distinct q.chunk) >= greatest(1, least(3, ceil((select count(*) from query_chunks)::numeric * 0.35))::integer)
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        coalesce(array_agg(distinct cv.variation_key) filter (where cv.variation_key is not null), '{}'::text[]) as variation_keys,
        public.marketplace_search_normalize(candidate_number.card_number) as normalized_number,
        public.marketplace_search_compact(candidate_number.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        (
          h.ngram_score +
          h.matched_chunks * 260 +
          c.search_weight * 0.35
        )::real as search_rank,
        h.matched_chunks,
        h.matched_ngram_chunks
      from chunk_hits h
      join public.marketplace_search_candidates c on c.card_id = h.card_id
      ${collectorNumberJoinSql('c', 'mc', 'b', 'candidate_number')}
      left join public.marketplace_card_variations cv on cv.card_id = c.card_id
      group by
        c.card_id,
        c.name,
        c.set_name,
        candidate_number.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        c.search_weight,
        h.ngram_score,
        h.matched_chunks,
        h.matched_ngram_chunks
      order by search_rank desc, c.name asc, c.card_number asc
      limit $2::integer
    `;
  const started = Date.now();
  try {
    const result = await withTimeout(
      query(sql, values),
      nameSearchTimeoutMs(),
      'predictive ngram search',
    );
    if (debug) {
      debug.predictiveNgrams = {
        used: true,
        path: query === marketplaceNameSearchQuery ? 'peer3_predictive_ngrams' : 'injected_predictive_ngrams',
        fallback: false,
        chunks,
        language: ngramLanguage,
        eventLanguage: ngramLanguage,
        languageFallback: 'none',
        candidateRowCount: result.rows.length,
        durationMs: Date.now() - started,
      };
    }
    return {
      rows: result.rows,
      chunks,
      hasStructuredToken,
      language: ngramLanguage,
      fallback: false,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (error.code === '42P01' || error.code === '42883' || error.code === '42703') {
      if (debug) {
        debug.predictiveNgrams = {
          used: false,
          reason: 'schema_not_applied',
          code: error.code,
          chunks,
          language: ngramLanguage,
          eventLanguage: ngramLanguage,
          languageFallback: 'none',
          durationMs: Date.now() - started,
        };
      }
      return null;
    }
    if (query === fallbackQuery || shouldAvoidPrimarySearchFallback(searchTerm)) {
      if (debug) {
        debug.predictiveNgrams = {
          used: false,
          reason: query === fallbackQuery ? 'query_failed' : 'primary_fallback_skipped_short_prefix',
          error: error.message || String(error),
          code: error.code,
          chunks,
          language: ngramLanguage,
          eventLanguage: ngramLanguage,
          languageFallback: 'none',
          durationMs: Date.now() - started,
        };
      }
      return null;
    }
    const fallbackStarted = Date.now();
    let fallbackResult;
    try {
      fallbackResult = await withTimeout(
        fallbackQuery(sql, values),
        nameSearchTimeoutMs(),
        'primary predictive ngram search',
      );
    } catch (fallbackError) {
      if (debug) {
        debug.predictiveNgrams = {
          used: false,
          reason: 'fallback_failed',
          error: error.message || String(error),
          code: error.code,
          fallbackError: fallbackError.message || String(fallbackError),
          fallbackCode: fallbackError.code,
          chunks,
          language: ngramLanguage,
          eventLanguage: ngramLanguage,
          languageFallback: 'none',
          durationMs: Date.now() - started,
          fallbackDurationMs: Date.now() - fallbackStarted,
        };
      }
      return null;
    }
    if (debug) {
      debug.predictiveNgrams = {
        used: true,
        path: 'primary_predictive_ngrams_fallback',
        fallback: true,
        reason: error.message || String(error),
        code: error.code,
        chunks,
        language: ngramLanguage,
        eventLanguage: ngramLanguage,
        languageFallback: 'none',
        candidateRowCount: fallbackResult.rows.length,
        durationMs: Date.now() - started,
        fallbackDurationMs: Date.now() - fallbackStarted,
      };
    }
    return {
      rows: fallbackResult.rows,
      chunks,
      hasStructuredToken,
      language: ngramLanguage,
      fallback: true,
      durationMs: Date.now() - started,
    };
  }
}

async function rowsForAutocompleteSearchTerm(
  searchTerm,
  poolLimit,
  searchLanguage,
  debug,
  previousContext,
  query = marketplaceQuery,
  predictiveQuery = marketplaceNameSearchQuery,
) {
  const contextRows = await searchStructuredAutocompleteWithContext(
    searchTerm,
    poolLimit,
    searchLanguage,
    previousContext,
    debug,
    query,
  );
  if (contextRows && contextRows.length > 0) {
    return contextRows;
  }

  const terms = searchTerms(searchTerm);
  let directNamePrefixRows = null;
  const genericEnergyRows = await searchGenericEnergyExpansionRowsWithDatabase(
    searchTerm,
    poolLimit,
    debug,
    query,
  );
  if (genericEnergyRows?.length > 0) {
    return genericEnergyRows;
  }

  if (shouldPreferDirectNamePrefix(searchTerm)) {
    try {
      directNamePrefixRows = await searchNameOnlyAutocompleteWithCardNameFanout(
        searchTerm,
        poolLimit,
        searchLanguage,
        debug,
        query,
      );
    } catch (error) {
      if (debug) {
        debug.directNamePrefix = {
          used: false,
          fallback: true,
          reason: error.message || String(error),
          code: error.code,
        };
      }
    }
  }
  if (directNamePrefixRows && directNamePrefixRows.length > 0) {
    return directNamePrefixRows;
  }

  const predictiveStarted = Date.now();
  const predictiveResult = await searchPredictiveNgramRowsWithDatabase(
    searchTerm,
    poolLimit,
    searchLanguage,
    debug,
    predictiveQuery,
    query,
  );
  if (predictiveResult?.rows?.length > 0) {
    const nameRequired = filterRowsByRequiredNameTokens(
      predictiveResult.rows,
      searchTerm,
    );
    const structuredTokens = terms
      .map((term) => ({ term, kind: tokenKind(term) }))
      .filter((token) => token.kind !== 'text' && token.kind !== 'rarity');
    let filteredRows = nameRequired.rows;
    let structuredApplied = false;
    if (structuredTokens.length > 0 && !nameRequired.applied) {
      const looseStructured = filterRowsByAnyStructuredToken(
        nameRequired.rows,
        structuredTokens,
      );
      if (looseStructured.applied) {
        filteredRows = looseStructured.rows;
        structuredApplied = true;
      } else {
        const structuredFilteredRows = await filterRowsByStoredStructuredTokens(
          predictiveResult.rows,
          structuredTokens,
        );
        if (structuredFilteredRows.length > 0) {
          filteredRows = structuredFilteredRows;
          structuredApplied = true;
        }
      }
    }
    if (debug) {
      debug.searchPath = 'typed_predictive_ngrams';
      debug.tokenPlan = {
        strategy: 'typed_predictive_ngrams',
        chunks: predictiveResult.chunks,
        structuredTokens,
        structuredTokenFilter: {
          applied: structuredApplied,
        },
        requiredNameTokens: nameRequired.requiredTokens,
        requiredNameTokenFilter: {
          applied: nameRequired.applied,
          filteredCount: nameRequired.filteredCount,
        },
        language: predictiveResult.language,
        eventLanguage: predictiveResult.language,
        languageFallback: 'none',
        candidateRowCount: predictiveResult.rows.length,
        matchedRowCount: filteredRows.length,
        fallback: predictiveResult.fallback,
        durationMs: Date.now() - predictiveStarted,
      };
    }
    if (filteredRows.length > 0) {
      if (
        structuredTokens.some((token) => token.kind === 'expansion') &&
        !structuredApplied &&
        !nameRequired.applied
      ) {
        const fanoutRows = await searchStructuredAutocompleteWithCandidateFanout(
          searchTerm,
          poolLimit,
          searchLanguage,
          debug,
          query,
        );
        if (fanoutRows && fanoutRows.length > 0) {
          return fanoutRows;
        }
      }
      return filteredRows.slice(0, poolLimit);
    }
  }
  const fanoutRows = await searchStructuredAutocompleteWithCandidateFanout(
    searchTerm,
    poolLimit,
    searchLanguage,
    debug,
    query,
  );
  if (fanoutRows && fanoutRows.length > 0) {
    return fanoutRows;
  }
  const combinedNameStarted = Date.now();
  const combinedNameRows = await searchCombinedCardNameWithDatabase(
    terms,
    poolLimit,
    query,
  );
  if (combinedNameRows.length > 0) {
    if (debug) {
      debug.tokenPlan = {
        strategy: 'combined_card_name',
        terms,
        candidateRowCount: combinedNameRows.length,
        matchedRowCount: combinedNameRows.length,
        durationMs: Date.now() - combinedNameStarted,
      };
    }
    return combinedNameRows;
  }
  const multiNameOnlyRows = terms.length > 1
    ? await searchNameOnlyAutocompleteWithCardNameFanout(
      searchTerm,
      poolLimit,
      searchLanguage,
      debug,
      query,
    )
    : null;
  if (multiNameOnlyRows && multiNameOnlyRows.length > 0) {
    return multiNameOnlyRows;
  }
  if (debug) {
    debug.fanoutFallback = true;
  }
  const tokenPlan = intersectionTokenPlan(searchTerm);
  if (!tokenPlan) {
    const rows = await rowsForSearchTerm(
      poolSearchTerm(searchTerm),
      poolLimit,
      0,
      searchLanguage,
      debug,
    );
    if (debug) {
      debug.tokenPlan = {
        strategy: 'ranked_pool',
        poolTerm: poolSearchTerm(searchTerm),
      };
    }
    return rows;
  }

  const perTokenLimit = structuredAutocompleteTokenLimit();
  const textTokens = tokenPlan.tokens.filter((token) => token.kind === 'text');
  const structuredTokens = tokenPlan.tokens.filter((token) => token.kind !== 'text');
  if (textTokens.length > 0 && structuredTokens.length > 0) {
    const started = Date.now();
    const nameRowsByToken = await Promise.all(textTokens.map(async (token) => {
      const tokenStarted = Date.now();
      const nameRows = await searchNameWithDatabase(
        token.term,
        perTokenLimit,
        0,
        searchLanguage,
      );
      const fallbackRows = shouldUseSupplementalNameFallback(token, nameRows)
        ? await searchNameTokenFallbackWithDatabase(token.term, perTokenLimit, 0, searchLanguage)
        : [];
      const rows = mergeRowsPreservingBest([nameRows, fallbackRows], perTokenLimit);
      return {
        ...token,
        rows,
        rawRowCount: nameRows.length,
        fallbackRowCount: fallbackRows.length,
        durationMs: Date.now() - tokenStarted,
      };
    }));
    const nameIntersection = intersectRows(
      nameRowsByToken.map((entry) => entry.rows),
      perTokenLimit,
    );
    const filteredRows = await filterRowsByStoredStructuredTokens(
      nameIntersection,
      structuredTokens,
    );
    if (debug) {
      debug.tokenPlan = {
        strategy: 'name_first_stored_dimension_intersection',
        tokens: [
          ...nameRowsByToken.map((entry) => ({
            term: entry.term,
            kind: entry.kind,
            rawRowCount: entry.rawRowCount,
            fallbackRowCount: entry.fallbackRowCount,
            rowCount: entry.rows.length,
            durationMs: entry.durationMs,
            topRows: entry.rows.slice(0, 6).map((row) => ({
              card_id: row.card_id,
              name: row.name,
              set_name: row.set_name,
              card_number: row.card_number,
              rarity: row.rarity,
              search_rank: Number(row.search_rank || 0),
            })),
          })),
          ...structuredTokens.map((token) => ({
            term: token.term,
            kind: token.kind,
            storedDimensionFilter: true,
          })),
        ],
        nameIntersectedRowCount: nameIntersection.length,
        intersectedRowCount: filteredRows.length,
        durationMs: Date.now() - started,
      };
    }
    if (filteredRows.length > 0) {
      return filteredRows.slice(0, poolLimit);
    }
    if (debug) {
      debug.tokenPlan.fallbackReason = 'empty_stored_dimension_intersection';
    }
    return [];
  }

  const tokenResults = await Promise.all(tokenPlan.tokens.map(async (token) => {
    const started = Date.now();
    const rows = token.kind === 'text'
      ? await searchNameWithDatabase(token.term, perTokenLimit, 0, searchLanguage)
      : await searchNonNameWithDatabase(token.term, perTokenLimit, 0, searchLanguage);
    return {
      ...token,
      rows: rows.filter((row) => rowMatchesIntersectionToken(row, token)),
      rawRowCount: rows.length,
      durationMs: Date.now() - started,
    };
  }));
  const orderedGroups = [...tokenResults]
    .sort((left, right) => left.rows.length - right.rows.length);
  const intersected = intersectRows(
    orderedGroups.map((entry) => entry.rows),
    poolLimit,
  );
  if (debug) {
    debug.tokenPlan = {
      strategy: 'intersection',
      tokens: tokenResults.map((entry) => ({
        term: entry.term,
        kind: entry.kind,
        rawRowCount: entry.rawRowCount,
        rowCount: entry.rows.length,
        durationMs: entry.durationMs,
        topRows: entry.rows.slice(0, 6).map((row) => ({
          card_id: row.card_id,
          name: row.name,
          set_name: row.set_name,
          card_number: row.card_number,
          rarity: row.rarity,
          search_rank: Number(row.search_rank || 0),
        })),
      })),
      intersectedRowCount: intersected.length,
      orderedBySelectivity: orderedGroups.map((entry) => entry.term),
    };
  }
  if (intersected.length > 0) {
    return intersected;
  }
  if (debug) {
    debug.tokenPlan.fallbackReason = 'empty_intersection';
  }
  return rowsForSearchTerm(
    poolSearchTerm(searchTerm),
    poolLimit,
    0,
    searchLanguage,
    debug,
  );
}

function boundedDistance(a, b, maxDistance) {
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let rowMin = maxDistance + 1;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, matrix[i - 2][j - 2] + 1);
      }
      matrix[i][j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
  }
  return matrix[a.length][b.length];
}

function scoreRow(row, query) {
  const name = String(row.name || '').toLowerCase();
  const set = String(row.set_name || '').toLowerCase();
  const number = String(row.card_number || row.version || row.card_id || '')
    .toLowerCase();
  const rarity = String(row.rarity || '').toLowerCase();
  const type = String(row.card_type || '').toLowerCase();
  const trainer = String(row.trainer_name || '').toLowerCase();
  const haystack = `${name} ${number} ${set} ${rarity} ${type} ${trainer}`;
  const compactQuery = compact(query);
  const compactName = compact(name);
  const compactNumber = compact(number);
  const terms = searchTerms(query);
  const nameWords = searchTerms(name);
  const hasNumberTerm = terms.some((term) => /^[0-9]+$/.test(term));
  const hasVariationTerm = terms.some(isVariationIntentTerm);
  const hasRarityTerm = terms.some(isRarityTerm);
  const hasExpansionAliasTerm = terms.some(isExpansionAliasTerm);
  const genericEnergyPlan = genericEnergyExpansionPlan(query);
  const fuzzyExpansionTerms = terms.filter((term) => {
    if (!term || /^[0-9]+$/.test(term) || isVariationIntentTerm(term) || isRarityTerm(term)) return false;
    const compactTerm = compact(term);
    const compactSet = compact(set);
    return compactTerm.length >= 5 &&
      compactSet.startsWith(compactTerm.slice(0, 3)) &&
      boundedDistance(compactSet.slice(0, compactTerm.length), compactTerm, 2) <= 2;
  });
  const hasTextTerm = terms.some((term) =>
    !/^[0-9]+$/.test(term) &&
    !isVariationIntentTerm(term) &&
    !isRarityTerm(term) &&
    !isExpansionAliasTerm(term));
  const singleVariationTerm =
    terms.length === 1 && isVariationTerm(terms[0]) ? terms[0] : null;
  const hasStructuredIntent =
    terms.length > 1 &&
    hasTextTerm &&
    (hasNumberTerm || hasVariationTerm || hasRarityTerm || hasExpansionAliasTerm);
  const singleTextTerm =
    terms.length === 1 && hasTextTerm && !hasStructuredIntent ? terms[0] : null;
  const confidentNameTerms = hasStructuredIntent
    ? confidentNameTokenSet(name, nameWords, terms)
    : new Set();
  const remoteScore = Number(row.search_rank || 0);
  const isProduct = String(row.item_kind || '') === 'product';
  const isSingleCardIdentity = !isProduct;
  const isPokemonIdentity = isPokemonIdentityRow(row);
  const productQuery = /\b(box|booster|pack|deck|display|collection|bundle|tin|blister|case|etb|dice|binder|premium|set)\b/i.test(query);
  let score = 0;

  if (singleVariationTerm) {
    if (rowHasVariation(row, singleVariationTerm)) {
      return 1600 + remoteScore * 0.35;
    }
    if (singleVariationTerm === 'vstar' && rowHasSetToken(row, singleVariationTerm)) {
      return 900 + remoteScore * 0.25;
    }
    return 0;
  }

  if (singleTextTerm) {
    const compactTerm = compact(singleTextTerm);
    if (isSingleCardIdentity && (name === singleTextTerm || compactName === compactTerm)) {
      score = Math.max(score, 5200);
    } else if (isSingleCardIdentity && (name.startsWith(singleTextTerm) || compactName.startsWith(compactTerm))) {
      score = Math.max(score, isPokemonIdentity ? 4900 : 4400);
    } else if (isSingleCardIdentity && nameWords.some((word) => word.startsWith(singleTextTerm))) {
      score = Math.max(score, isPokemonIdentity ? 4300 : 3800);
    } else if (isSingleCardIdentity && isLikelyNameTokenTypo(nameWords, singleTextTerm)) {
      score = Math.max(score, 3600);
    } else if (!isProduct && name.includes(singleTextTerm)) {
      score = Math.max(score, 2600);
    } else if (isProduct && !productQuery) {
      if (name.startsWith(singleTextTerm) || compactName.startsWith(compactTerm)) {
        score = Math.max(score, 900);
      } else if (name.includes(singleTextTerm) || set.includes(singleTextTerm)) {
        score = Math.max(score, 220);
      }
    }
  }

  if (number === query) score = Math.max(score, 980);
  if (compactNumber.startsWith(compactQuery) && compactQuery) {
    score = Math.max(score, 880);
  }
  if (name === query) score = Math.max(score, isSingleCardIdentity ? 1420 : 1000);
  if (compactName === compactQuery) score = Math.max(score, isSingleCardIdentity ? 1380 : 980);
  if (compactName.startsWith(compactQuery) && compactQuery) {
    const singlePrefixScore = compactQuery.length >= 5 ? 1140 : 820;
    score = Math.max(score, isPokemonIdentity ? 1180 : isSingleCardIdentity ? singlePrefixScore : 820);
  }
  if (name.includes(query)) score = Math.max(score, 680);
  if (number.includes(query)) score = Math.max(score, 700);
  if (set.includes(query)) score = Math.max(score, 360);
  if (rarity.includes(query)) score = Math.max(score, 340);

  if (
    terms.length > 1 &&
    (hasNumberTerm || hasVariationTerm || hasExpansionAliasTerm) &&
    hasTextTerm
  ) {
    let intentScore = 0;
    let matchedName = false;
    let matchedNumber = false;
    let matchedVariation = false;
    let matchedExpansion = false;
    let matchedSet = false;
    for (const term of terms) {
      const compactTerm = compact(term);
      if (/^[0-9]+$/.test(term)) {
        const numberTokens = searchTerms(number);
        if (number === term || compactNumber === compactTerm || numberTokens.includes(term)) {
          intentScore += 1600;
          matchedNumber = true;
        } else if (number.startsWith(term) || compactNumber.startsWith(compactTerm)) {
          intentScore += 1300;
          matchedNumber = true;
        } else if (number.includes(term) || compactNumber.includes(compactTerm)) {
          intentScore += 900;
          matchedNumber = true;
        }
        continue;
      }
      if (isVariationIntentTerm(term)) {
        if (rowHasVariationIntent(row, term)) {
          intentScore += 1500;
          matchedVariation = true;
        }
        continue;
      }
      if (isExpansionAliasTerm(term)) {
        if (rowHasExpansionAlias(row, term)) {
          intentScore += 1550;
          matchedExpansion = true;
        }
        continue;
      }
      const canMatchName = !hasStructuredIntent || confidentNameTerms.has(term);
      if (canMatchName && (name === term || compactName === compactTerm)) {
        intentScore += 1400;
        matchedName = true;
      } else if (canMatchName && (name.startsWith(term) || compactName.startsWith(compactTerm))) {
        intentScore += 1150;
        matchedName = true;
      } else if (canMatchName && nameWords.some((word) => word.startsWith(term))) {
        intentScore += 980;
        matchedName = true;
      } else if (canMatchName && isLikelyNameTokenTypo(nameWords, term)) {
        intentScore += 920;
        matchedName = true;
      } else if (
        canMatchName &&
        compactTerm.length >= 5 &&
        compactName.startsWith(compactTerm.slice(0, 2)) &&
        boundedDistance(compactName, compactTerm, 3) <= 3
      ) {
        intentScore += 760;
        matchedName = true;
      } else if (
        canMatchName &&
        (name.includes(term) || (compactTerm.length >= 4 && compactName.includes(compactTerm)))
      ) {
        intentScore += 720;
        matchedName = true;
      } else if (set.startsWith(term) || compact(set).startsWith(compactTerm)) {
        intentScore += 520;
        matchedSet = true;
      } else if (set.includes(term) || compact(set).includes(compactTerm)) {
        intentScore += 360;
        matchedSet = true;
      } else if (fuzzyExpansionTerms.includes(term)) {
        intentScore += 700;
        matchedSet = true;
      }
    }
    if (matchedName && matchedNumber) {
      score = Math.max(score, intentScore + 5200);
    } else if (matchedName && matchedVariation) {
      score = Math.max(score, intentScore + 4400);
    } else if (matchedName && matchedExpansion) {
      score = Math.max(score, intentScore + 4600);
    } else if (matchedName && matchedSet) {
      score = Math.max(score, intentScore + 700);
    } else if (matchedName && hasVariationTerm) {
      score = Math.max(score, intentScore + 900);
    } else if (matchedNumber || matchedVariation || matchedExpansion) {
      score = Math.min(score, 1);
    }
  }

  if (compactQuery.length >= 4 && compactName) {
    const prefix = compactName.slice(0, compactQuery.length);
    const distance = boundedDistance(prefix, compactQuery, 2);
    if (distance <= 1) score = Math.max(score, 760 - distance * 80);
    if (
      compactQuery.length >= 5 &&
      Math.abs(compactName.length - compactQuery.length) <= 2
    ) {
      const fullDistance = boundedDistance(compactName, compactQuery, 2);
      if (fullDistance <= 2) score = Math.max(score, 900 - fullDistance * 90);
    }
  }

  for (const term of terms) {
    const compactTerm = compact(term);
    if (!compactTerm) continue;
    let matchedNameTerm = false;
    const canMatchName = !hasStructuredIntent || confidentNameTerms.has(term);
    if (canMatchName && nameWords.includes(term)) {
      score += isSingleCardIdentity ? 1040 : 760;
      matchedNameTerm = true;
    } else if (canMatchName && isLikelyNameTokenTypo(nameWords, term)) {
      score += isSingleCardIdentity ? 920 : 620;
      matchedNameTerm = true;
    } else if (canMatchName && compactName === compactTerm) {
      score += 900;
      matchedNameTerm = true;
    } else if (canMatchName && compactName.startsWith(compactTerm)) {
      const singlePrefixScore = compactTerm.length >= 5 ? 940 : 720;
      score += isPokemonIdentity ? 980 : isSingleCardIdentity ? singlePrefixScore : 720;
      matchedNameTerm = true;
    } else if (canMatchName && compactTerm.length >= 4) {
      const prefix = compactName.slice(0, compactTerm.length);
      const distance = boundedDistance(prefix, compactTerm, 2);
      if (distance <= 1) {
        score += 620 - distance * 80;
        matchedNameTerm = true;
      }
    }
    if (matchedNameTerm) continue;
    if (compactNumber === compactTerm || compact(set) === compactTerm) {
      score += 520;
    } else if (
      compactNumber.startsWith(compactTerm) ||
      compact(set).startsWith(compactTerm)
    ) {
      score += 320;
    }
    if (rarity.includes(term)) {
      score += 180;
    }
  }

  if (terms.length > 1) {
    if (terms.every((term) => haystack.includes(term))) {
      score = Math.max(score, 620 + terms.length * 40);
    }
    const nameMatches = terms.filter((term) => {
      const compactTerm = compact(term);
      return compactTerm && (!hasStructuredIntent || confidentNameTerms.has(term)) && (
        compactName.startsWith(compactTerm) ||
        isLikelyNameTokenTypo(nameWords, term) ||
        boundedDistance(compactName.slice(0, compactTerm.length), compactTerm, 2) <= 1
      );
    }).length;
    if (nameMatches > 0) {
      score += 420 * nameMatches;
    }
  }

  if (terms.length > 1 && hasRarityTerm && hasTextTerm) {
    let rarityScore = 420;
    let matchedName = false;
    let matchedRarity = false;
    for (const term of terms) {
      if (isRarityTerm(term)) {
        if (rowHasRarity(row, term)) {
          rarityScore += 420;
          matchedRarity = true;
        }
      } else if ((!hasStructuredIntent || confidentNameTerms.has(term)) && name.startsWith(term)) {
        rarityScore += 260;
        matchedName = true;
      } else if ((!hasStructuredIntent || confidentNameTerms.has(term)) && nameWords.some((word) => word.startsWith(term))) {
        rarityScore += 220;
        matchedName = true;
      } else if ((!hasStructuredIntent || confidentNameTerms.has(term)) && name.includes(term)) {
        rarityScore += 160;
        matchedName = true;
      }
    }
    if (matchedName && matchedRarity) {
      score = Math.max(score, rarityScore);
    }
  }

  if (hasStructuredIntent && score <= 0) {
    return 0;
  }

  if (isProduct && !productQuery) {
    score -= 900;
  } else if (isProduct) {
    score -= 80;
  }
  if (!isSingleCardIdentity && /^[a-z]{2,}$/.test(compactQuery) && compactQuery.length <= 5) {
    score -= 220;
  }
  if (terms.length > 1 && fuzzyExpansionTerms.length > 0) {
    const matchedName = terms.some((term) => {
      const compactTerm = compact(term);
      return compactTerm &&
        !fuzzyExpansionTerms.includes(term) &&
        (nameWords.includes(term) || compactName.startsWith(compactTerm));
    });
    if (matchedName) score += 2200 + fuzzyExpansionTerms.length * 520;
  }
  if (genericEnergyPlan && rowMatchesAnyExpansionToken(row, genericEnergyPlan.expansionTokens)) {
    if (isEnergyCardName(row)) {
      score += nameWords.length === 2 ? 5200 : 3400;
    } else if (nameWords[0] === 'energy') {
      score += 900;
    }
  }
  const remoteMultiplier = isProduct && !productQuery ? 0.18 : 0.35;
  const finalScore = Math.max(score, remoteScore * remoteMultiplier);
  return Math.max(
    0,
    finalScore +
      compoundNameCoverageAdjustment(row, query, terms, nameWords, finalScore) +
      missingNameRootCoverageAdjustment(row, query, finalScore),
  );
}

function dedupeRows(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const id = String(row.card_id || row.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

function attachCanonicalPath(row, lookupPath = '') {
  const stored = String(
    row.canonical_path || row.canonicalPath || lookupPath || '',
  ).trim();
  const path = canonicalPathForRow({
    ...row,
    canonical_path: stored,
    canonicalPath: stored,
  });
  const withPath = path ? { ...row, canonical_path: path, canonicalPath: path } : row;
  return normalizeMarketplaceRow(withPath);
}

async function hydrateCanonicalPathsForRows(rows, query = marketplaceQuery) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const missingIds = [...new Set(sourceRows
    .filter((row) => !String(row.canonical_path || row.canonicalPath || '').trim())
    .map((row) => Number(row.card_id || row.id || 0))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (missingIds.length === 0) {
    return sourceRows.map((row) => attachCanonicalPath(row));
  }
  let pathById = new Map();
  try {
    const result = await query(
      `
        select card_id, canonical_path
        from public.marketplace_card_urls
        where (card_id = any($1::bigint[]) or ct_id = any($1::bigint[]))
          and language = 'en'
      `,
      [missingIds],
    );
    pathById = new Map(
      (result.rows || []).map((row) => [
        String(row.card_id || ''),
        String(row.canonical_path || '').trim(),
      ]),
    );
  } catch (error) {
    console.error('autocomplete canonical path hydration failed', error);
  }
  return sourceRows.map((row) => {
    const lookup = pathById.get(String(row.card_id || row.id || '')) || '';
    return attachCanonicalPath(row, lookup);
  });
}

async function hydrateProjectedRarityForRows(rows, query = marketplaceQuery) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(sourceRows
    .filter((row) => {
      const rarity = String(row.rarity || '').trim().toLowerCase();
      return !rarity || rarity === 'card';
    })
    .map((row) => Number(row.card_id || row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) {
    return sourceRows;
  }
  try {
    const result = await query(
      `
        select
          blueprints.id as card_id,
          coalesce(
            nullif(tcg_metadata.raw_metadata#>>'{sourceCard,rarity}', ''),
            nullif(blueprints.blueprint->>'rarity', ''),
            nullif(blueprints.blueprint->>'collector_rarity', ''),
            nullif(blueprints.blueprint#>>'{fixed_properties,pokemon_rarity}', '')
          ) as projected_rarity
        from public.cardtrader_pokemon_blueprints blueprints
        left join public.marketplace_blueprint_tcg_metadata tcg_metadata
          on tcg_metadata.blueprint_id = blueprints.id
        where blueprints.id = any($1::bigint[])
      `,
      [ids],
    );
    const rarityById = new Map(
      result.rows
        .map((row) => [
          String(row.card_id || ''),
          String(row.projected_rarity || '').trim(),
        ])
        .filter(([, rarity]) => rarity && rarity.toLowerCase() !== 'card'),
    );
    return sourceRows.map((row) => {
      const rarity = String(row.rarity || '').trim();
      if (rarity && rarity.toLowerCase() !== 'card') {
        return row;
      }
      const projectedRarity = rarityById.get(String(row.card_id || row.id || '')) || '';
      return projectedRarity ? { ...row, rarity: projectedRarity } : row;
    });
  } catch (error) {
    console.error('autocomplete rarity hydration failed', error);
    return sourceRows;
  }
}

async function hydrateExpansionSymbolsForRows(rows, query = marketplaceQuery) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const rowsWithRarity = await hydrateProjectedRarityForRows(sourceRows, query);
  const rowsWithCanonicalPaths = await hydrateCanonicalPathsForRows(rowsWithRarity, query);
  const missingSetNames = [...new Set(rowsWithCanonicalPaths
    .filter((row) => !String(row.expansion_symbol_url || '').trim())
    .map((row) => String(row.set_name || '').trim())
    .filter(Boolean))];
  if (missingSetNames.length === 0) {
    return rowsWithCanonicalPaths;
  }
  try {
    const result = await query(
      `
        select
          name,
          min(symbol_image_url) as expansion_symbol_url
        from public.pokoin_pokemon_expansions
        where name = any($1::text[])
          and coalesce(symbol_image_url, '') <> ''
        group by name
      `,
      [missingSetNames],
    );
    const symbolByName = new Map(
      result.rows.map((row) => [
        String(row.name || '').trim(),
        String(row.expansion_symbol_url || '').trim(),
      ]),
    );
    return rowsWithCanonicalPaths.map((row) => {
      if (String(row.expansion_symbol_url || '').trim()) {
        return row;
      }
      const symbolUrl = symbolByName.get(String(row.set_name || '').trim());
      return symbolUrl ? { ...row, expansion_symbol_url: symbolUrl } : row;
    });
  } catch (error) {
    console.error('autocomplete expansion symbol hydration failed', error);
    return rowsWithCanonicalPaths;
  }
}

async function hotPreviewPoolRowsWithDatabase(poolLimit, query = marketplaceQuery) {
  const result = await query(
    `
      select
        c.card_id,
        c.name,
        c.set_name,
        c.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        (
          c.search_weight +
          least(coalesce(h.hot_score_1h, 0), 5000) * 0.35 +
          least(coalesce(h.hot_score_24h, 0), 15000) * 0.12 +
          least(coalesce(h.hot_score_7d, 0), 40000) * 0.03 +
          least(coalesce(h.searches_24h, 0), 500) * 8 +
          least(coalesce(h.clicks_24h, 0), 500) * 14 +
          least(coalesce(h.cart_adds_24h, 0), 100) * 28 +
          least(coalesce(h.reserves_24h, 0), 100) * 34 +
          least(coalesce(h.sales_24h, 0), 50) * 55 +
          least(coalesce(s.active_listing_count, 0), 50) * 24 +
          least(coalesce(s.listed_quantity, 0), 200) * 4
        )::real as search_rank
      from public.marketplace_hot_blueprints h
      join public.marketplace_search_candidates c
        on c.card_id = h.blueprint_id
      left join public.marketplace_blueprint_price_summary s
        on s.blueprint_id = h.blueprint_id
      where coalesce(h.hot_score_1h, 0) > 0
        or coalesce(h.hot_score_24h, 0) > 0
        or coalesce(h.hot_score_7d, 0) > 0
        or coalesce(h.searches_24h, 0) > 0
        or coalesce(h.clicks_24h, 0) > 0
        or coalesce(h.cart_adds_24h, 0) > 0
        or coalesce(h.reserves_24h, 0) > 0
        or coalesce(h.sales_24h, 0) > 0
      order by search_rank desc, h.last_event_at desc nulls last, c.name asc
      limit $1::integer
    `,
    [Math.min(Math.max(poolLimit, 1), 1000)],
  );
  return result.rows;
}

async function hotPreviewPool(poolLimit, query = marketplaceQuery) {
  const limit = Math.min(Math.max(poolLimit, 1), 1000);
  const cacheKey = `${limit}`;
  const now = Date.now();
  const cacheState = hotPreviewPoolCaches.get(query) || {};
  if (
    cacheState.cache?.key === cacheKey &&
    now - cacheState.cache.createdAtMs < HOT_PREVIEW_POOL_TTL_MS
  ) {
    return { rows: cacheState.cache.rows, source: 'hot_analytics_server_cache_hit' };
  }
  if (cacheState.cache?.key === cacheKey && cacheState.refresh) {
    return { rows: cacheState.cache.rows, source: 'hot_analytics_server_cache_stale' };
  }
  const refresh = hotPreviewPoolRowsWithDatabase(limit, query)
    .then((rows) => {
      cacheState.cache = { key: cacheKey, rows, createdAtMs: Date.now() };
      return rows;
    })
    .finally(() => {
      cacheState.refresh = null;
    });
  cacheState.refresh = refresh;
  hotPreviewPoolCaches.set(query, cacheState);
  return { rows: await refresh, source: 'hot_analytics_server_cache_refresh' };
}

function emptyAnalyticsBoosts() {
  const boosts = new Map();
  boosts.siteBoosts = new Map();
  boosts.userBoosts = new Map();
  boosts.sources = {
    site: 'marketplace_hot_blueprints',
    user: 'none',
  };
  return boosts;
}

async function optionalPersonalizationUser(req) {
  const header = requestHeader(req, 'authorization');
  if (!header.startsWith('Bearer ')) {
    return { uid: null, error: null };
  }
  try {
    const decoded = await verifyBearerToken(req);
    return {
      uid: typeof decoded.uid === 'string' && decoded.uid.trim()
        ? decoded.uid.trim().slice(0, 128)
        : null,
      error: null,
    };
  } catch (error) {
    console.warn('autocomplete personalization auth skipped', error);
    return {
      uid: null,
      error: {
        message: error.message || 'Autocomplete personalization auth failed.',
        code: error.code,
        statusCode: error.statusCode,
      },
    };
  }
}

async function analyticsBoostsForRows(rows, query = marketplaceQuery, userUid = null) {
  const ids = [...new Set((rows || [])
    .map((row) => Number(row.card_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))]
    .slice(0, 500);
  if (ids.length === 0) return emptyAnalyticsBoosts();
  const result = await query(
    `
      select
        h.blueprint_id::text as card_id,
        (
          least(coalesce(h.hot_score_1h, 0), 5000) * 0.35 +
          least(coalesce(h.hot_score_24h, 0), 15000) * 0.12 +
          least(coalesce(h.hot_score_7d, 0), 40000) * 0.03 +
          least(coalesce(h.searches_24h, 0), 500) * 8 +
          least(coalesce(h.clicks_24h, 0), 500) * 14 +
          least(coalesce(h.cart_adds_24h, 0), 100) * 28 +
          least(coalesce(h.reserves_24h, 0), 100) * 34 +
          least(coalesce(h.sales_24h, 0), 50) * 55 +
          least(coalesce(s.active_listing_count, 0), 50) * 24 +
          least(coalesce(s.listed_quantity, 0), 200) * 4
        )::real as analytics_boost
      from public.marketplace_hot_blueprints h
      left join public.marketplace_blueprint_price_summary s
        on s.blueprint_id = h.blueprint_id
      where h.blueprint_id = any($1::bigint[])
    `,
    [ids],
  );
  const siteBoosts = new Map(result.rows.map((row) => [
    String(row.card_id),
    Number(row.analytics_boost || 0),
  ]));
  const userBoosts = new Map();
  if (userUid) {
    try {
      const userResult = await query(
        `
          select
            e.card_id::text as card_id,
            (
              least(coalesce(sum(e.weight) filter (where e.occurred_at >= now() - interval '1 hour'), 0), 500) * 1.25 +
              least(coalesce(sum(e.weight) filter (where e.occurred_at >= now() - interval '24 hours'), 0), 1500) * 0.55 +
              least(coalesce(sum(e.weight) filter (where e.occurred_at >= now() - interval '30 days'), 0), 3000) * 0.18 +
              least(count(*) filter (where e.event_type = 'search' and e.occurred_at >= now() - interval '30 days'), 30) * 14 +
              least(count(*) filter (where e.event_type in ('view', 'click') and e.occurred_at >= now() - interval '30 days'), 60) * 10 +
              least(count(*) filter (where e.event_type in ('cart_add', 'reserve', 'sale') and e.occurred_at >= now() - interval '30 days'), 20) * 35
            )::real as user_boost
          from public.marketplace_card_events e
          where e.card_id = any($1::bigint[])
            and e.user_uid = $2
            and e.occurred_at >= now() - interval '30 days'
          group by e.card_id
        `,
        [ids, userUid],
      );
      for (const row of userResult.rows) {
        userBoosts.set(String(row.card_id), Number(row.user_boost || 0));
      }
    } catch (error) {
      if (error.code !== '42703') {
        throw error;
      }
    }
  }
  const boosts = new Map();
  for (const id of ids.map(String)) {
    boosts.set(id, Number(siteBoosts.get(id) || 0) + Number(userBoosts.get(id) || 0));
  }
  boosts.siteBoosts = siteBoosts;
  boosts.userBoosts = userBoosts;
  boosts.sources = {
    site: 'marketplace_hot_blueprints',
    user: userUid ? 'marketplace_card_events:user_uid' : 'none',
  };
  return boosts;
}

async function namePrefixRowsForOneCharacterSearch(
  searchTerm,
  poolLimit,
  searchLanguage = 'en',
  query = marketplaceNameSearchQuery,
  fallbackQuery = marketplaceQuery,
  debug = null,
  shardPlan = null,
) {
  const compactTerm = compact(searchTerm);
  if (compactTerm.length !== 1) return [];
  const sql = `
      with shard_buckets as (
        select
          bucket->>'kind' as kind,
          bucket->>'start' as start_char,
          bucket->>'end' as end_char
        from jsonb_array_elements($4::jsonb) bucket
      )
      select
        c.card_id,
        c.name,
        c.set_name,
        c.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        c.item_kind,
        c.product_type,
        c.trainer_name,
        c.canonical_name,
        c.image_url,
        c.cdn_image_url,
        c.preview_image_url,
        c.card_palette,
        c.emoji,
        c.imported_at,
        '{}'::text[] as variation_keys,
        public.marketplace_search_normalize(c.card_number) as normalized_number,
        public.marketplace_search_compact(c.card_number) as compact_number,
        public.marketplace_search_normalize(c.set_name) as normalized_set,
        public.marketplace_search_compact(c.set_name) as compact_set,
        public.marketplace_search_normalize(c.trainer_name) as normalized_trainer,
        public.marketplace_search_compact(c.trainer_name) as compact_trainer,
        public.marketplace_search_normalize(c.product_variant) as normalized_variant,
        public.marketplace_search_compact(c.product_variant) as compact_variant,
        (
          case
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) = $1 then 3600
            when public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like $1 || '%' then 3400
            when exists (
              select 1
              from public.marketplace_card_names_for_language($3::text) names
              where names.name = coalesce(nullif(c.canonical_name, ''), c.name)
                and names.compact_name like $1 || '%'
            ) then 3200
            else 2600
          end +
          c.search_weight +
          least(coalesce(h.hot_score_1h, 0), 5000) * 0.35 +
          least(coalesce(h.hot_score_24h, 0), 15000) * 0.12 +
          least(coalesce(h.hot_score_7d, 0), 40000) * 0.03 +
          least(coalesce(h.searches_24h, 0), 500) * 8 +
          least(coalesce(h.clicks_24h, 0), 500) * 14 +
          least(coalesce(h.cart_adds_24h, 0), 100) * 28 +
          least(coalesce(h.reserves_24h, 0), 100) * 34 +
          least(coalesce(h.sales_24h, 0), 50) * 55 +
          least(coalesce(s.active_listing_count, 0), 50) * 24 +
          least(coalesce(s.listed_quantity, 0), 200) * 4
        )::real as search_rank
      from public.marketplace_search_candidates c
      left join public.marketplace_hot_blueprints h
        on h.blueprint_id = c.card_id
      left join public.marketplace_blueprint_price_summary s
        on s.blueprint_id = c.card_id
      where
        exists (
          select 1
          from shard_buckets bucket
          where (
            bucket.kind = 'range'
            and (
              public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name))
                between $1 || bucket.start_char and $1 || bucket.end_char || repeat('z', 80)
              or exists (
                select 1
                from public.marketplace_card_names_for_language($3::text) names
                where names.name = coalesce(nullif(c.canonical_name, ''), c.name)
                  and names.compact_name between $1 || bucket.start_char and $1 || bucket.end_char || repeat('z', 80)
              )
            )
          ) or (
            bucket.kind = 'non_alpha'
            and (
              public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) = $1
              or (
                public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) like $1 || '%'
                and substring(public.marketplace_search_compact(coalesce(nullif(c.canonical_name, ''), c.name)) from 2 for 1)
                  !~ '^[a-z]$'
              )
              or exists (
                select 1
                from public.marketplace_card_names_for_language($3::text) names
                where names.name = coalesce(nullif(c.canonical_name, ''), c.name)
                  and (
                    names.compact_name = $1
                    or (
                      names.compact_name like $1 || '%'
                      and substring(names.compact_name from 2 for 1) !~ '^[a-z]$'
                    )
                  )
              )
            )
          )
        )
      order by search_rank desc, h.last_event_at desc nulls last, c.name asc, c.card_number asc
      limit $2::integer
    `;
  const cleanPoolLimit = Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT);
  const shardBuckets = shardPlan?.buckets || PREFIX_SHARD_SECONDARY_BUCKETS;
  const values = [
    compactTerm,
    cleanPoolLimit,
    cleanLanguage(searchLanguage),
    JSON.stringify(shardBuckets),
  ];
  const timeoutMs = nameSearchTimeoutMs();
  const timedQuery = async (queryFn, label) => withTimeout(queryFn(sql, values), timeoutMs, label);
  try {
    const result = await timedQuery(query, `one-character prefix ${shardPlan?.label || compactTerm}`);
    if (debug) {
      debug.prefixPool = {
        path: query === marketplaceNameSearchQuery ? 'peer3_name_prefix' : 'injected_name_prefix',
        fallback: false,
        shardRange: shardPlan?.label,
        dbRole: shardPlan?.role,
        rowCount: result.rows.length,
      };
    }
    return result.rows;
  } catch (error) {
    if (query === fallbackQuery || shouldAvoidPrimarySearchFallback(searchTerm)) {
      throw error;
    }
    console.error('one-character name prefix search failed; falling back to primary', error);
    const result = await timedQuery(fallbackQuery, `primary one-character prefix ${shardPlan?.label || compactTerm}`);
    if (debug) {
      debug.prefixPool = {
        path: 'primary_name_prefix_fallback',
        fallback: true,
        shardRange: shardPlan?.label,
        dbRole: shardPlan?.role,
        reason: error.message || String(error),
        code: error.code,
        rowCount: result.rows.length,
      };
    }
    return result.rows;
  }
}

async function shardedNamePrefixRowsForOneCharacterSearch(
  searchTerm,
  poolLimit,
  searchLanguage = 'en',
  debug = null,
  clients = getMarketplacePrefixSearchClients(),
) {
  const compactTerm = compact(searchTerm);
  if (compactTerm.length !== 1) return [];
  const shardPlans = oneCharacterPrefixShardPlan(searchTerm, clients);
  if (shardPlans.length === 0) return [];
  const started = Date.now();
  const primaryClient = clients.find((client) => client.role === 'primary') || clients[0];
  const shardLimit = Math.min(Math.max(poolLimit, 1), AUTOCOMPLETE_ONE_CHAR_BACKEND_POOL_LIMIT);
  const shardResults = await Promise.all(shardPlans.map(async (plan) => {
    const shardStarted = Date.now();
    const shardDebug = {};
    const circuitKey = `${plan.role}:${plan.label}`;
    const disabledUntil = prefixShardDisabledUntil.get(circuitKey) || 0;
    const circuitOpen = plan.role !== 'primary' && Date.now() < disabledUntil;
    const shardQuery = circuitOpen ? null : plan.client?.query || null;
    try {
      if (!shardQuery) {
        return {
          index: plan.index,
          role: plan.role,
          range: plan.label,
          fallback: false,
          skipped: true,
          circuitOpen,
          disabledUntil: circuitOpen ? disabledUntil : undefined,
          reason: circuitOpen ? 'prefix shard circuit open' : 'no replica client for prefix shard',
          durationMs: Date.now() - shardStarted,
          rowCount: 0,
          rows: [],
        };
      }
      const rows = await namePrefixRowsForOneCharacterSearch(
        searchTerm,
        shardLimit,
        searchLanguage,
        shardQuery,
        primaryClient.query,
        shardDebug,
        plan,
      );
      return {
        index: plan.index,
        role: plan.role,
        range: plan.label,
        fallback: circuitOpen || Boolean(shardDebug.prefixPool?.fallback),
        circuitOpen,
        disabledUntil: circuitOpen ? disabledUntil : undefined,
        reason: circuitOpen ? 'prefix shard circuit open' : shardDebug.prefixPool?.reason,
        code: shardDebug.prefixPool?.code,
        durationMs: Date.now() - shardStarted,
        rowCount: rows.length,
        rows,
      };
    } catch (error) {
      if (plan.role !== 'primary') {
        prefixShardDisabledUntil.set(circuitKey, Date.now() + nameSearchCircuitMs());
      }
      return {
        index: plan.index,
        role: plan.role,
        range: plan.label,
        fallback: false,
        failed: true,
        reason: error.message || String(error),
        code: error.code,
        durationMs: Date.now() - shardStarted,
        rowCount: 0,
        rows: [],
      };
    }
  }));
  const byId = new Map();
  for (const result of shardResults) {
    for (const row of result.rows) {
      const id = rowKey(row);
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing || Number(row.search_rank || 0) > Number(existing.search_rank || 0)) {
        byId.set(id, row);
      }
    }
  }
  const rows = [...byId.values()]
    .sort((left, right) => {
      const scoreDiff = Number(right.search_rank || 0) - Number(left.search_rank || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(left.name || '').localeCompare(String(right.name || '')) ||
        String(left.card_number || '').localeCompare(String(right.card_number || ''));
    })
    .slice(0, shardLimit);
  if (debug) {
    debug.prefixPool = {
      path: 'typed_one_character_sharded_prefix',
      fallback: shardResults.some((result) => result.fallback),
      shardCount: shardResults.length,
      shardRanges: shardResults.map((result) => result.range),
      shards: shardResults.map((result) => ({
        index: result.index,
        range: result.range,
        dbRole: result.role,
        fallback: result.fallback,
        circuitOpen: Boolean(result.circuitOpen),
        failed: Boolean(result.failed),
        skipped: Boolean(result.skipped),
        reason: result.reason,
        code: result.code,
        disabledUntil: result.disabledUntil,
        durationMs: result.durationMs,
        rowCount: result.rowCount,
      })),
      rawRowCount: shardResults.reduce((sum, result) => sum + result.rowCount, 0),
      rowCount: rows.length,
      durationMs: Date.now() - started,
    };
  }
  return rows;
}

async function rowsForAutocompleteSearchTermWithQuery(
  searchTerm,
  poolLimit,
  searchLanguage,
  debug,
  previousContext,
  query = marketplaceQuery,
  nameIndexQuery = supabaseNameIndexQuery,
  predictionContext = null,
) {
  if (useMeiliSearchForLanguage(searchLanguage)) {
    const meiliPoolTerm = poolSearchTerm(searchTerm);
    const rows = await rowsForSearchTerm(
      meiliPoolTerm,
      poolLimit,
      0,
      searchLanguage,
      debug,
      previousContext,
      { meiliOnly: true },
    );
    if (rows?.length > 0) {
      if (debug) {
        debug.searchPath = debug.searchPath || 'meili_en_autocomplete_pool';
        debug.tokenPlan = {
          strategy: debug.tokenPlan?.strategy || 'meili_en_autocomplete_pool',
          poolTerm: meiliPoolTerm,
          candidateRowCount: rows.length,
        };
      }
      return rows;
    }
    if (debug) {
      const meiliSearchPath = debug.searchPath;
      const meiliSearchEngine = debug.searchEngine ? { ...debug.searchEngine } : null;
      const meiliTokenPlan = debug.tokenPlan ? { ...debug.tokenPlan } : null;
      debug.meiliAutocompleteFallback = {
        reason: meiliSearchEngine?.reason || 'empty_meili_pool',
        poolTerm: meiliPoolTerm,
        searchPath: meiliSearchPath,
        candidateRowCount: rows?.length || 0,
        searchEngine: meiliSearchEngine,
        tokenPlan: meiliTokenPlan,
      };
      if (String(debug.searchPath || '').startsWith('meili_')) {
        delete debug.searchPath;
      }
      if (String(debug.tokenPlan?.strategy || '').startsWith('meili_')) {
        delete debug.tokenPlan;
      }
    }
  }
  const readQuery = readQueryForAutocomplete(searchTerm, query);
  const canUseSupabaseNameTier = query === marketplaceQuery || nameIndexQuery !== supabaseNameIndexQuery;
  if (canUseSupabaseNameTier && shouldTrySupabaseNameIndex(searchTerm, previousContext)) {
    const rows = await rowsFromSupabaseNameIndex(
      searchTerm,
      poolLimit,
      searchLanguage,
      debug,
      readQuery,
      nameIndexQuery,
    );
    if (rows?.length > 0) {
      return rows;
    }
  } else if (debug) {
    debug.supabaseNameIndex = {
      used: false,
      fallback: true,
      decision: supabaseNameIndexDecision(searchTerm, previousContext),
    };
  }
  if (canUseSupabaseNameTier && shouldTrySupabaseOneCharNameIndex(searchTerm)) {
    const rows = await rowsFromSupabaseOneCharNameIndex(
      searchTerm,
      poolLimit,
      searchLanguage,
      debug,
      nameIndexQuery,
    );
    if (rows?.length > 0) {
      return rows;
    }
  } else if (debug && compact(searchTerm).length === 1) {
    debug.supabaseOneCharNameIndex = {
      used: false,
      fallback: true,
      decision: {
        configured: supabasePredictionConfigured(),
        circuitOpen: supabaseNameIndexCircuitOpen(),
        depth: meaningfulSearchDepth(searchTerm),
        shouldTry: shouldTrySupabaseOneCharNameIndex(searchTerm),
      },
    };
  }
  if (query === marketplaceQuery && predictivePoolEnabled()) {
    const predictiveRows = await buildPredictivePoolWithFanout(
      searchTerm,
      poolLimit,
      searchLanguage,
      previousContext,
      debug,
      nameIndexQuery,
      predictionContext,
    );
    if (predictiveRows?.length > 0) {
      return predictiveRows;
    }
  }
  if (compact(searchTerm).length === 1) {
    const started = Date.now();
    const candidateStarted = Date.now();
    const rows = await shardedNamePrefixRowsForOneCharacterSearch(
      searchTerm,
      poolLimit,
      searchLanguage,
      debug,
      query === marketplaceQuery ? getMarketplacePrefixSearchClients() : [{ role: 'injected', query }],
    );
    const candidateDurationMs = Date.now() - candidateStarted;
    if (debug) {
      debug.searchPath = 'typed_one_character_sharded_prefix';
      debug.tokenPlan = {
        strategy: 'typed_one_character_sharded_prefix',
        poolLimit,
        shardCount: debug.prefixPool?.shardCount || 0,
        shardRanges: debug.prefixPool?.shardRanges || [],
        candidateRowCount: rows.length,
        matchedRowCount: rows.length,
        candidateDurationMs,
        durationMs: Date.now() - started,
      };
    }
    return rows;
  }
  return rowsForAutocompleteSearchTerm(
    searchTerm,
    poolLimit,
    searchLanguage,
    debug,
    previousContext,
    readQuery,
    query === marketplaceQuery ? marketplaceNameSearchQuery : query,
  );
}

function scoreExplanation(row, query) {
  const normalizedQuery = normalizeVariationPhrases(query).toLowerCase();
  const terms = searchTerms(normalizedQuery);
  return {
    card_id: row.card_id,
    name: row.name,
    set_name: row.set_name,
    card_number: row.card_number,
    rarity: row.rarity,
    product_variant: row.product_variant,
    item_kind: row.item_kind,
    product_type: row.product_type,
    db_rank: Number(row.search_rank || 0),
    score: scoreRow(row, normalizedQuery),
    matchedTerms: terms.filter((term) => {
      const text = [
        row.name,
        row.set_name,
        row.card_number,
        row.rarity,
        row.product_variant,
      ].join(' ').toLowerCase();
      return text.includes(term) ||
        rowHasVariation(row, term) ||
        rowHasRarity(row, term) ||
        rowHasSetToken(row, term);
    }),
  };
}

function depthScoreForRow(row, depthScores = {}) {
  const id = String(row.card_id || row.id || '');
  if (!id) return 0;
  const score = Number(depthScores[id] || 0);
  return Number.isFinite(score) && score > 0 ? score : 0;
}

function depthMetadataForRow(row, metadata = {}) {
  const id = String(row.card_id || row.id || '');
  if (!id) return { latestDepth: 0, latestOrder: Number.MAX_SAFE_INTEGER };
  const latestDepth = Number(metadata.latestDepths?.[id] || 0);
  const latestOrder = Number(metadata.latestOrders?.[id]);
  return {
    latestDepth: Number.isFinite(latestDepth) && latestDepth > 0 ? latestDepth : 0,
    latestOrder: Number.isFinite(latestOrder) && latestOrder >= 0
      ? latestOrder
      : Number.MAX_SAFE_INTEGER,
  };
}

function rankAutocompleteEntries(rows, query, limit, analyticsBoosts = new Map(), options = {}) {
  const normalizedQuery = normalizeVariationPhrases(query).toLowerCase();
  const depthScores = options.depthScores || {};
  const depthMetadata = options.depthMetadata || {};
  return dedupeRows(rows)
    .map((row) => {
      const relevanceScore = scoreRow(row, normalizedQuery);
      const rawAnalyticsBoost = Number(analyticsBoosts.get(String(row.card_id || '')) || 0);
      const boostCap = relevanceScore >= 5000 ? 1800 : relevanceScore >= 4200 ? 900 : 450;
      const analyticsBoost = Math.min(rawAnalyticsBoost, boostCap);
      const depthWeight = depthScoreForRow(row, depthScores);
      const { latestDepth, latestOrder } = depthMetadataForRow(row, depthMetadata);
      const depthBoostCap = relevanceScore >= 5000 ? 900 : relevanceScore >= 4200 ? 650 : 360;
      const depthBoost = relevanceScore > 0
        ? (latestDepth * 1200) + Math.min(depthWeight * 45, depthBoostCap)
        : 0;
      return {
        row,
        score: relevanceScore + analyticsBoost + depthBoost,
        relevanceScore,
        analyticsBoost,
        depthWeight,
        latestDepth,
        latestOrder,
        depthBoost,
      };
    })
    .filter((entry) => entry.relevanceScore > 0)
    .sort((a, b) => {
      if (b.latestDepth !== a.latestDepth) return b.latestDepth - a.latestDepth;
      if (b.score !== a.score) return b.score - a.score;
      if (a.latestOrder !== b.latestOrder) return a.latestOrder - b.latestOrder;
      return String(a.row.name || '').localeCompare(String(b.row.name || ''));
    })
    .slice(0, limit);
}

function rankAutocompleteRows(rows, query, limit, analyticsBoosts = new Map(), options = {}) {
  return rankAutocompleteEntries(rows, query, limit, analyticsBoosts, options).map((entry) => entry.row);
}

function debugEnabled(req) {
  return req.body?.debug === true || req.body?.debug === '1';
}

function cacheControlForRequest(req, publicCacheControl) {
  return req.method === 'POST'
    ? 'no-store'
    : publicCacheControl;
}

async function optionalDebugUser(req, wantsDebug) {
  if (!wantsDebug) {
    return { user: null, error: null };
  }
  try {
    return { user: await authorizeSearchDebugRequest(req), error: null };
  } catch (error) {
    console.warn('search debug authorization skipped', error);
    return {
      user: null,
      error: {
        message: error.message || 'Search debug authorization failed.',
        code: error.code,
        statusCode: error.statusCode,
      },
    };
  }
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const searchTerm = cleanSearchTerm(
      req.body?.search_term ?? req.body?.searchTerm ?? req.body?.query,
    );
    const resultLimit = cleanLimit(req.body?.result_limit ?? req.body?.limit);
    const requestedPoolLimit = cleanLimit(req.body?.pool_limit ?? 1000);
    const candidateLadder = autocompleteCandidateIdLadder(searchTerm);
    const poolLimit = searchTerm
      ? Math.min(
        autocompleteCandidateIdAppliedLimit(searchTerm),
        cleanLimit(req.body?.pool_limit ?? autocompleteBackendPoolLimit(searchTerm)),
      )
      : cleanAutocompletePoolLimit(req.body?.pool_limit);
    const searchLanguage = cleanLanguage(req.body?.search_language ?? req.body?.language);
    const previewMode = cleanSearchTerm(req.body?.preview_mode ?? req.body?.previewMode);
    const previousSearchContext = req.body?.previous_search_context ?? req.body?.previousSearchContext;
    const predictionContext = req.body?.prediction_context ??
      req.body?.predictionContext ??
      req.body?.previous_prediction_context ??
      req.body?.previousPredictionContext;
    const searchSessionId = cleanSearchSessionId(
      req.body?.search_session_id ??
        req.body?.searchSessionId ??
        req.body?.session_id ??
        req.body?.sessionId,
    );
    const cancelState = searchCancelState(req, searchSessionId);
    const wantsDebug = debugEnabled(req);
    const debugAuth = await optionalDebugUser(req, wantsDebug);
    const personalization = await optionalPersonalizationUser(req);
    if (isSearchCanceled(cancelState)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(
        canceledAutocompleteResponse(searchTerm, searchLanguage, cancelState),
      );
    }
    if (!searchTerm) {
      const started = Date.now();
      const candidateStarted = Date.now();
      const hotPool = await hotPreviewPool(poolLimit, marketplaceAnalyticsSearchQuery);
      if (isSearchCanceled(cancelState)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(
          canceledAutocompleteResponse(searchTerm, searchLanguage, cancelState),
        );
      }
      const poolRows = hotPool.rows;
      const candidateDurationMs = Date.now() - candidateStarted;
      const rankStarted = Date.now();
      const previewLimit = Math.min(resultLimit, AUTOCOMPLETE_PREVIEW_ROW_LIMIT);
      const ranked = (await hydrateExpansionSymbolsForRows(poolRows.slice(0, previewLimit)))
        .map((row) => withCardEmojiFields(normalizeMarketplaceRow(row)));
      const rankDurationMs = Date.now() - rankStarted;
      const durationMs = Date.now() - started;
      const searchContext = buildSearchContext('', searchLanguage, poolRows, 'hot_analytics_pool', null, poolLimit);
      const pool = {
        source: hotPool.source,
        size: poolRows.length,
        limit: poolLimit,
        requestedLimit: requestedPoolLimit,
        previewLimit,
        ttlSeconds: 60,
      };
      res.setHeader(
        'Cache-Control',
        cacheControlForRequest(req, 'public, max-age=10, s-maxage=60, stale-while-revalidate=120'),
      );
      res.setHeader(
        'Server-Timing',
        `autocomplete-empty;dur=${durationMs}, candidate;dur=${candidateDurationMs}, rank;dur=${rankDurationMs}`,
      );
      return res.status(200).json({
        rows: ranked,
        pool,
        search_context: searchContext,
        ...(wantsDebug
          ? {
              debug: {
                sessionId: cleanSearchTerm(req.body?.debug_session_id),
                user: debugAuth.user,
                debugAuthError: debugAuth.error,
                searchTerm,
                resultLimit,
                poolLimit,
                requestedPoolLimit,
                searchLanguage,
                searchPath: 'empty_hot_analytics',
                poolSource: pool.source,
                poolSize: poolRows.length,
                candidateDurationMs,
                rankDurationMs,
                durationMs,
                replicaPath: 'peer4_primary',
                replicaFallback: false,
            rankingSignals: {
              trendingSource: 'marketplace_hot_blueprints',
              userSource: 'client_recent_views_for_empty_focus',
              personalizationUser: personalization.uid ? 'verified_firebase_uid' : 'anonymous',
              personalizationAuthError: personalization.error,
            },
              },
            }
          : {}),
      });
    }

    const started = Date.now();
    if (previewMode === 'name') {
      const previewLimit = Math.min(resultLimit, AUTOCOMPLETE_PREVIEW_ROW_LIMIT);
      const rows = await searchFastNamePreviewWithDatabase(
        searchTerm,
        previewLimit,
        searchLanguage,
      );
      if (isSearchCanceled(cancelState)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(
          canceledAutocompleteResponse(searchTerm, searchLanguage, cancelState),
        );
      }
      const analyticsBoosts = await analyticsBoostsForRows(
        rows,
        marketplaceAnalyticsSearchQuery,
        personalization.uid,
      );
      const rankedEntries = rankAutocompleteEntries(rows, searchTerm, previewLimit, analyticsBoosts);
      const ranked = (await hydrateExpansionSymbolsForRows(
        rankedEntries.map((entry) => entry.row),
      )).map((row) => withCardEmojiFields(normalizeMarketplaceRow(row)));
      const durationMs = Date.now() - started;
      res.setHeader('Cache-Control', cacheControlForRequest(req, 'public, max-age=5, s-maxage=30'));
      res.setHeader('Server-Timing', `autocomplete-name;dur=${durationMs}`);
      if (wantsDebug) {
        return res.status(200).json({
          rows: ranked,
          pool: {
            source: 'name_preview_pipeline',
            size: rows.length,
            limit: previewLimit,
            previewLimit,
            strategy: 'fast_name_preview',
          },
          debug: {
            previewMode,
            searchTerm,
            resultLimit,
            searchLanguage,
            searchPath: 'fast_name_preview',
            poolSource: 'name_preview_pipeline',
            poolSize: rows.length,
            candidateDurationMs: durationMs,
            rankDurationMs: 0,
            replicaPath: 'peer4_primary',
            replicaFallback: false,
            durationMs,
            candidateRows: rows.length,
            analyticsBoostedRows: analyticsBoosts.size,
            rankingSignals: {
              siteBoostedRows: analyticsBoosts.siteBoosts?.size || 0,
              userBoostedRows: analyticsBoosts.userBoosts?.size || 0,
              trendingSource: analyticsBoosts.sources?.site,
              userSource: analyticsBoosts.sources?.user,
              personalizationUser: personalization.uid ? 'verified_firebase_uid' : 'anonymous',
              personalizationAuthError: personalization.error,
            },
          },
        });
      }
      return res.status(200).json(ranked);
    }

    const candidateDebug = wantsDebug ? { steps: [] } : null;
    const candidateStarted = Date.now();
    const rows = await rowsForAutocompleteSearchTermWithQuery(
      searchTerm,
      poolLimit,
      searchLanguage,
      candidateDebug,
      previousSearchContext,
      marketplaceQuery,
      supabaseNameIndexQuery,
      predictionContext,
    );
    const candidateDurationMs = Date.now() - candidateStarted;
    const analyticsStarted = Date.now();
    const canceledAfterCandidates = isSearchCanceled(cancelState);
    const skipAnalytics = canceledAfterCandidates || shouldSkipAnalyticsForSearchTerm(searchTerm);
    const analyticsBoosts = skipAnalytics
      ? emptyAnalyticsBoosts()
      : await analyticsBoostsForRows(
        rows,
        marketplaceAnalyticsSearchQuery,
        personalization.uid,
      );
    const analyticsDurationMs = Date.now() - analyticsStarted;
    if (canceledAfterCandidates) {
      const durationMs = Date.now() - started;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Server-Timing',
        `autocomplete-canceled;dur=${durationMs}, candidate;dur=${candidateDurationMs}, analytics;dur=0`,
      );
      return res.status(200).json(
        canceledAutocompleteResponse(searchTerm, searchLanguage, cancelState),
      );
    }
    const depthScores = updateDepthScores(previousSearchContext, searchTerm, searchLanguage, rows);
    const depthMetadata = updateDepthMetadata(previousSearchContext, searchTerm, searchLanguage, rows);
    const rankStarted = Date.now();
    const rankedEntries = rankAutocompleteEntries(
      rows,
      searchTerm,
      Math.min(resultLimit, AUTOCOMPLETE_PREVIEW_ROW_LIMIT),
      analyticsBoosts,
      { depthScores, depthMetadata },
    );
    const ranked = (await hydrateExpansionSymbolsForRows(
      rankedEntries.map((entry) => entry.row).slice(0, AUTOCOMPLETE_PREVIEW_ROW_LIMIT),
    )).map((row) => withCardEmojiFields(normalizeMarketplaceRow(row)));
    const rankDurationMs = Date.now() - rankStarted;
    const durationMs = Date.now() - started;
    const contextStrategy = candidateDebug?.tokenPlan?.strategy || 'ranked_pool';
    const searchContext = buildSearchContext(
      searchTerm,
      searchLanguage,
      rows,
      contextStrategy,
      previousSearchContext,
      poolLimit,
    );
    const replicaDebug = candidateDebug?.variationSearch || candidateDebug?.prefixPool || null;
    const pool = {
      source: previousSearchContext ? 'context_or_search_pipeline' : 'search_pipeline',
      size: rows.length,
      limit: poolLimit,
      requestedLimit: requestedPoolLimit,
      candidateIdLimit: candidateLadder.requestedLimit,
      appliedCandidateIdLimit: candidateLadder.appliedLimit,
      previewLimit: Math.min(resultLimit, AUTOCOMPLETE_PREVIEW_ROW_LIMIT),
      strategy: contextStrategy,
    };
    res.setHeader('Cache-Control', cacheControlForRequest(req, 'public, max-age=5, s-maxage=30'));
    res.setHeader(
      'Server-Timing',
      `autocomplete;dur=${durationMs}, candidate;dur=${candidateDurationMs}, analytics;dur=${analyticsDurationMs}, rank;dur=${rankDurationMs}`,
    );
    if (wantsDebug) {
      return res.status(200).json({
        rows: ranked,
        search_language: searchLanguage,
        search_context: searchContext,
        debug: {
          sessionId: cleanSearchTerm(req.body?.debug_session_id),
          user: debugAuth.user,
          debugAuthError: debugAuth.error,
          searchTerm,
          poolTerm: poolSearchTerm(searchTerm),
          resultLimit,
          poolLimit,
          requestedPoolLimit,
          searchLanguage,
          searchPath: candidateDebug?.searchPath || contextStrategy,
          poolSource: pool.source,
          poolSize: rows.length,
          candidateIdLimit: candidateLadder.requestedLimit,
          appliedCandidateIdLimit: candidateLadder.appliedLimit,
          candidateIdLadder: candidateLadder,
          replicaPath: replicaDebug?.path || candidateDebug?.searchPath || 'peer3_name_plus_dimension',
          replicaFallback: Boolean(replicaDebug?.path && replicaDebug.path.includes('fallback')) ||
            Boolean(replicaDebug?.fallback) ||
            candidateDebug?.searchPath === 'primary_full_fallback',
          durationMs,
          candidateDurationMs,
          analyticsDurationMs,
          rankDurationMs,
          candidateRows: rows.length,
          candidateDebug,
          analyticsSkipped: skipAnalytics,
          ranked: rankedEntries.slice(0, 12).map((entry) => ({
            ...scoreExplanation(entry.row, searchTerm),
            score: entry.score,
            relevanceScore: entry.relevanceScore,
            siteBoost: Number(analyticsBoosts.siteBoosts?.get(String(entry.row.card_id || '')) || 0),
            userBoost: Number(analyticsBoosts.userBoosts?.get(String(entry.row.card_id || '')) || 0),
            analyticsBoost: entry.analyticsBoost,
            depthWeight: entry.depthWeight,
            latestDepth: entry.latestDepth,
            latestOrder: entry.latestOrder,
            depthBoost: entry.depthBoost,
            textRelevance: entry.relevanceScore,
            trendingSource: analyticsBoosts.sources?.site,
          })),
          rankingSignals: {
            siteBoostedRows: analyticsBoosts.siteBoosts?.size || 0,
            userBoostedRows: analyticsBoosts.userBoosts?.size || 0,
            trendingSource: analyticsBoosts.sources?.site,
            userSource: analyticsBoosts.sources?.user,
            personalizationUser: personalization.uid ? 'verified_firebase_uid' : 'anonymous',
            personalizationAuthError: personalization.error,
          },
        },
      });
    }
    return res.status(200).json({
      rows: ranked,
      search_language: searchLanguage,
      pool,
      search_context: searchContext,
    });
  } catch (error) {
    console.error('marketplace-autocomplete failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace autocomplete failed.',
    });
  }
};

module.exports.poolSearchTerm = poolSearchTerm;
module.exports.cleanAutocompletePoolLimit = cleanAutocompletePoolLimit;
module.exports.autocompleteCandidateIdLadder = autocompleteCandidateIdLadder;
module.exports.autocompleteCandidateIdRequestedLimit = autocompleteCandidateIdRequestedLimit;
module.exports.autocompleteCandidateIdAppliedLimit = autocompleteCandidateIdAppliedLimit;
module.exports.shouldSkipAnalyticsForSearchTerm = shouldSkipAnalyticsForSearchTerm;
module.exports.shouldAvoidPrimarySearchFallback = shouldAvoidPrimarySearchFallback;
module.exports.searchCancelState = searchCancelState;
module.exports.isSearchCanceled = isSearchCanceled;
module.exports.canceledAutocompleteResponse = canceledAutocompleteResponse;
module.exports.readQueryForAutocomplete = readQueryForAutocomplete;
module.exports.compact = compact;
module.exports.normalizeVariationPhrases = normalizeVariationPhrases;
module.exports.expansionAliasTargets = expansionAliasTargets;
module.exports.isExpansionAliasTerm = isExpansionAliasTerm;
module.exports.genericEnergyExpansionPlan = genericEnergyExpansionPlan;
module.exports.searchGenericEnergyExpansionRowsWithDatabase = searchGenericEnergyExpansionRowsWithDatabase;
module.exports.intersectionTokenPlan = intersectionTokenPlan;
module.exports.candidateFanoutPlan = candidateFanoutPlan;
module.exports.cleanSearchContext = cleanSearchContext;
module.exports.intersectRows = intersectRows;
module.exports.predictiveChunksForQuery = predictiveChunksForQuery;
module.exports.shouldTrySupabaseNameIndex = shouldTrySupabaseNameIndex;
module.exports.supabaseNameIndexDecision = supabaseNameIndexDecision;
module.exports.resetSupabaseNameIndexCircuitForTest = resetSupabaseNameIndexCircuitForTest;
module.exports.supabaseNameIndexCandidateRows = supabaseNameIndexCandidateRows;
module.exports.expandSupabaseNameIndexRows = expandSupabaseNameIndexRows;
module.exports.supabaseRestNameIndexCandidateRows = supabaseRestNameIndexCandidateRows;
module.exports.shouldTrySupabaseOneCharNameIndex = shouldTrySupabaseOneCharNameIndex;
module.exports.supabaseOneCharNameTokenRows = supabaseOneCharNameTokenRows;
module.exports.supabaseRestOneCharNameTokenRows = supabaseRestOneCharNameTokenRows;
module.exports.rowsFromSupabaseOneCharNameIndex = rowsFromSupabaseOneCharNameIndex;
module.exports.supabasePredictedNameTokens = supabasePredictedNameTokens;
module.exports.supabaseRestPredictedNameTokens = supabaseRestPredictedNameTokens;
module.exports.predictedNameTokensFromSupabase = predictedNameTokensFromSupabase;
module.exports.predictiveNameFragmentCandidates = predictiveNameFragmentCandidates;
module.exports.predictiveRowsForNamePredictions = predictiveRowsForNamePredictions;
module.exports.predictiveVerifiedDimensionRowsWithDatabase = predictiveVerifiedDimensionRowsWithDatabase;
module.exports.rowsFromSupabaseNameIndex = rowsFromSupabaseNameIndex;
module.exports.searchPredictiveNgramRowsWithDatabase = searchPredictiveNgramRowsWithDatabase;
module.exports.searchNameTokenFallbackWithDatabase = searchNameTokenFallbackWithDatabase;
module.exports.searchFastNamePreviewWithDatabase = searchFastNamePreviewWithDatabase;
module.exports.searchStructuredAutocompleteWithContext = searchStructuredAutocompleteWithContext;
module.exports.searchStructuredAutocompleteWithCandidateFanout = searchStructuredAutocompleteWithCandidateFanout;
module.exports.searchNameOnlyAutocompleteWithCardNameFanout = searchNameOnlyAutocompleteWithCardNameFanout;
module.exports.searchCombinedCardNameWithDatabase = searchCombinedCardNameWithDatabase;
module.exports.searchNameOnlyRowsWithDatabase = searchNameOnlyRowsWithDatabase;
module.exports.shouldUseSupplementalNameFallback = shouldUseSupplementalNameFallback;
module.exports.filterRowsByStoredStructuredTokens = filterRowsByStoredStructuredTokens;
module.exports.filterRowsByRequiredNameTokens = filterRowsByRequiredNameTokens;
module.exports.rowMatchesIntersectionToken = rowMatchesIntersectionToken;
module.exports.rankAutocompleteRows = rankAutocompleteRows;
module.exports.rankAutocompleteEntries = rankAutocompleteEntries;
module.exports.buildSearchContext = buildSearchContext;
module.exports.candidateLabelsForRows = candidateLabelsForRows;
module.exports.updateDepthScores = updateDepthScores;
module.exports.rowsForAutocompleteSearchTerm = rowsForAutocompleteSearchTerm;
module.exports.rowsForAutocompleteSearchTermWithQuery = rowsForAutocompleteSearchTermWithQuery;
module.exports.predictivePoolPlan = predictivePoolPlan;
module.exports.cleanPredictionContext = cleanPredictionContext;
module.exports.predictionSetsFromContext = predictionSetsFromContext;
module.exports.mergePredictivePoolRows = mergePredictivePoolRows;
module.exports.buildPredictivePoolWithFanout = buildPredictivePoolWithFanout;
module.exports.firstNameAnchorForPredictivePlan = firstNameAnchorForPredictivePlan;
module.exports.anchoredPredictionSets = anchoredPredictionSets;
module.exports.predictiveDimensionRowsWithDatabase = predictiveDimensionRowsWithDatabase;
module.exports.analyticsBoostsForRows = analyticsBoostsForRows;
module.exports.emptyAnalyticsBoosts = emptyAnalyticsBoosts;
module.exports.optionalPersonalizationUser = optionalPersonalizationUser;
module.exports.hotPreviewPoolRowsWithDatabase = hotPreviewPoolRowsWithDatabase;
module.exports.hotPreviewPool = hotPreviewPool;
module.exports.oneCharacterPrefixShardPlan = oneCharacterPrefixShardPlan;
module.exports.distributePrefixShardBuckets = distributePrefixShardBuckets;
module.exports.shardedNamePrefixRowsForOneCharacterSearch = shardedNamePrefixRowsForOneCharacterSearch;
module.exports.namePrefixRowsForOneCharacterSearch = namePrefixRowsForOneCharacterSearch;
module.exports.hotRowsForOneCharacterSearch = namePrefixRowsForOneCharacterSearch;
module.exports.scoreExplanation = scoreExplanation;
module.exports.scoreRow = scoreRow;
module.exports.cacheControlForRequest = cacheControlForRequest;
module.exports.setCorsHeaders = setCorsHeaders;
module.exports.hydrateCanonicalPathsForRows = hydrateCanonicalPathsForRows;
module.exports.attachCanonicalPath = attachCanonicalPath;
