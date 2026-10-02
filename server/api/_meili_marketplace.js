const { defaultIndexName, meiliConfigured, meiliSearch } = require('./_meili_client');

function cleanSearchTerm(value) {
  return String(value || '').trim().slice(0, 80);
}

function foldDiacritics(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function compact(value) {
  return foldDiacritics(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function meiliMarketplaceIndexName() {
  return String(process.env.MEILI_MARKETPLACE_INDEX || defaultIndexName());
}

function meiliNameTokenIndexName() {
  return String(process.env.MEILI_NAME_TOKEN_INDEX || 'marketplace_name_tokens');
}

function meiliSearchLimit(value, fallback = 100, min = 1) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), min), 1000);
}

function queryTokens(value) {
  return cleanSearchTerm(value)
    .split(/\s+/)
    .map((token) => compact(token))
    .filter(Boolean);
}

const SUGGEST_ATTRIBUTES = [
  'card_id',
  'name',
  'name_group',
  'card_number',
  'rarity',
  'set_name',
  'expansion_name',
  'expansion_aliases',
  'nicknames',
  'cdn_image_url',
  'canonical_path',
  'search_weight',
  'nationality',
  'effective_print_bucket',
  '_rankingScore',
];

// Typeahead is a card-name picker. Meili attribute order already prefers
// `name` over `set_name`, but a leftover "g" still matches Guardians Rising
// in set_name. Search only name + collector number so "mimikyu g" binds to GX.
// https://www.meilisearch.com/docs/learn/relevancy/attribute_ranking_order
const SUGGEST_SEARCH_ON = [
  'name',
  'name_normalized',
  'name_compact',
  'name_group',
  'nicknames',
  'card_number',
];

// Search menu folds Korean print into Japanese (jpko) — match both buckets.
function printBucketFilter(value) {
  const want = String(value || '').trim().toLowerCase();
  if (!want || want === 'all') {
    return '';
  }
  if (want === 'japanese' || want === 'ja' || want === 'jp' || want === 'ko' || want === 'korean') {
    return '(effective_print_bucket = "japanese" OR effective_print_bucket = "korean")';
  }
  return `effective_print_bucket = "${want}"`;
}

async function meiliMarketplaceCandidates(searchTerm, searchLanguage, limit, offset = 0, options = {}) {
  if (!meiliConfigured()) {
    const error = new Error('Meilisearch is not configured for marketplace candidates.');
    error.code = 'MEILI_NOT_CONFIGURED';
    throw error;
  }
  const q = cleanSearchTerm(searchTerm);
  const tokens = queryTokens(q);
  const filter = ['language = "en"'];
  const printClause = printBucketFilter(options.printLanguage || options.print_language);
  const wantPrintFilter = Boolean(printClause);
  if (wantPrintFilter) {
    filter.push(printClause);
  }
  const searchBody = {
    q,
    limit: meiliSearchLimit(limit, 120),
    offset: meiliSearchLimit(offset, 0, 0),
    showRankingScore: true,
    attributesToRetrieve: ['card_id', '_rankingScore', 'effective_print_bucket', 'nationality'],
    attributesToHighlight: [],
    // Every meaningful token must hit (typo/alias/prefix tolerance unchanged).
    // The engine default "last" silently drops trailing tokens, which reduced
    // "pikachu gx 30th" to "pikachu" for both rows and result counts.
    matchingStrategy: 'all',
    ...(tokens.length > 0 ? { facets: ['language'] } : {}),
    filter,
  };
  let response;
  try {
    response = await meiliSearch(meiliMarketplaceIndexName(), searchBody);
  } catch (error) {
    if (!wantPrintFilter) throw error;
    searchBody.filter = ['language = "en"'];
    response = await meiliSearch(meiliMarketplaceIndexName(), searchBody);
  }
  const hits = (response.hits || []).map((hit, index) => ({
    card_id: String(hit.card_id || ''),
    meili_rank: Number(hit._rankingScore || 0),
    meili_position: index + 1,
  })).filter((row) => row.card_id);
  // Same-query count: estimatedTotalHits answers the exact searchBody above
  // (q + filters + strategy), so rows and total always share one predicate.
  return {
    hits,
    estimatedTotalHits: Number(response.estimatedTotalHits || response.nbHits || hits.length) || 0,
  };
}

async function meiliMarketplaceSuggestHits(searchTerm, searchLanguage, limit = 24, options = {}) {
  if (!meiliConfigured()) {
    const error = new Error('Meilisearch is not configured for marketplace suggestions.');
    error.code = 'MEILI_NOT_CONFIGURED';
    throw error;
  }
  const q = cleanSearchTerm(searchTerm);
  const printClause = printBucketFilter(options.printLanguage || options.print_language);
  const wantPrintFilter = Boolean(printClause);
  const filter = ['language = "en"'];
  if (wantPrintFilter) {
    filter.push(printClause);
  }
  const body = {
    q,
    limit: meiliSearchLimit(limit, 24),
    offset: 0,
    showRankingScore: true,
    attributesToRetrieve: SUGGEST_ATTRIBUTES,
    attributesToSearchOn: SUGGEST_SEARCH_ON,
    attributesToHighlight: [],
    filter,
  };
  // Corrected semantic lookups may require every token to match so a
  // resolver anchor cannot silently vanish (default Meili "last" relaxes).
  if (options.matchingStrategy === 'all') {
    body.matchingStrategy = 'all';
  }
  let response;
  let printFilterApplied = wantPrintFilter;
  try {
    response = await meiliSearch(meiliMarketplaceIndexName(), body);
  } catch (error) {
    // Pre-reindex indexes lack effective_print_bucket as filterable. Fall
    // back to unfiltered retrieve so post-Meili hard filter still applies.
    if (!wantPrintFilter) throw error;
    body.filter = ['language = "en"'];
    response = await meiliSearch(meiliMarketplaceIndexName(), body);
    printFilterApplied = false;
  }
  const hits = (response.hits || []).filter((hit) => String(hit.card_id || '').trim());
  return {
    hits,
    estimatedTotalHits: Number(response.estimatedTotalHits || response.nbHits || hits.length) || 0,
    printFilterApplied,
  };
}

async function meiliPredictedNameTokens(fragment, searchLanguage, limit = 20) {
  if (!meiliConfigured()) {
    const error = new Error('Meilisearch is not configured for name-token predictions.');
    error.code = 'MEILI_NOT_CONFIGURED';
    throw error;
  }
  const q = cleanSearchTerm(fragment);
  const normalized = compact(q);
  const language = 'en';
  const response = await meiliSearch(meiliNameTokenIndexName(), {
    q,
    limit: meiliSearchLimit(limit, 20),
    showRankingScore: true,
    filter: ['language = "en"'],
    attributesToRetrieve: [
      'display_token',
      'normalized_token',
      'language',
      'card_count',
      'candidate_card_ids',
      '_rankingScore',
    ],
  });
  return (response.hits || []).map((hit, index) => ({
    display_token: String(hit.display_token || ''),
    normalized_token: compact(hit.normalized_token || hit.display_token || ''),
    confidence: Math.max(60, Math.round(Number(hit._rankingScore || 0) * 100)),
    score: Number(hit._rankingScore || 0) * 100000,
    source_rank: index + 1,
    language,
    matched_prefix: normalized,
    card_count: Number(hit.card_count || 0),
    ids_count: Array.isArray(hit.candidate_card_ids) ? hit.candidate_card_ids.length : 0,
    candidate_card_ids: Array.isArray(hit.candidate_card_ids)
      ? hit.candidate_card_ids.slice(0, 24).map((id) => String(id))
      : [],
    source: 'meili_name_token',
  })).filter((row) => row.display_token && row.normalized_token);
}

module.exports = {
  meiliMarketplaceIndexName,
  meiliNameTokenIndexName,
  meiliMarketplaceCandidates,
  meiliMarketplaceSuggestHits,
  meiliPredictedNameTokens,
};
