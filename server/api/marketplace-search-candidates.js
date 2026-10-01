'use strict';

// Vendored from CardVault pokemon_card_vault/api/marketplace-search-candidates.js
// — the webpage's search candidate engine. pokoin-web owns this copy from now
// on (the CardVault api/ layer is deprecated for the website); the Pi release
// overlay in scripts/deploy-search-api.sh ships this file over the CardVault
// copy. Production bug fixed here: the withTotal branch returned
// attachThemePacks(...) without await, so { rows } was a Promise and
// marketplace-cards' productType/print filters crashed with
// "next.filter is not a function" (Singles tab) and silently emptied results.

const {
  marketplaceNameSearchQuery,
  marketplaceQuery,
  marketplaceVariationSearchQuery,
} = require('./_marketplace_db');
const { withCardEmojiFields } = require('./_marketplace_card_emoji');
const { authorizeSearchDebugRequest } = require('./_search_debug_auth');
const {
  marketplaceSearchEngine,
  marketplaceSearchShadowEnabled,
  useMeiliSearchForLanguage,
} = require('./_marketplace_search_engine');
const { meiliMarketplaceCandidates } = require('./_meili_marketplace');
const { canonicalPathForRow } = require('./_marketplace_canonical_path');
const sql = require('./_marketplace_react_sql');

const SEARCH_RPC_V2 = 'search_marketplace_blueprint_candidates_v2';
const SEARCH_NAME_RPC = 'search_marketplace_blueprint_name_candidates';
const SEARCH_NON_NAME_RPC = 'search_marketplace_blueprint_non_name_candidates';

let nameSearchDisabledUntil = 0;
let variationSearchDisabledUntil = 0;

function cleanSearchTerm(value) {
  return String(value || '').trim().slice(0, 80);
}

function cleanLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return 20;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 15874);
}

function cleanOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(offset), 0), 15874);
}

function cleanLanguage(value) {
  const language = String(value || 'en').trim().toLowerCase();
  if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) {
    return language;
  }
  return 'en';
}

function foldDiacritics(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function compact(value) {
  return foldDiacritics(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function searchTerms(value) {
  const rawTerms = foldDiacritics(value)
    .replace(/&/g, ' tagteam ')
    .replace(/\blv\s*\.?\s*x\b/gi, 'lvx')
    .replace(/\blevel\s+x\b/gi, 'lvx')
    .replace(/\bv\s*max\b/gi, 'vmax')
    .replace(/\bv\s*star\b/gi, 'vstar')
    .replace(/\bg\s*x\b/gi, 'gx')
    .replace(/\be\s*x\b/gi, 'ex')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter(Boolean);
  return rawTerms.filter((term) =>
    term.length >= 2 ||
    term === 'v' ||
    term === 'n' ||
    ((term === 'g' || term === 'e') && rawTerms.length > 1));
}

const variationTerms = new Set([
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

function isVariationTerm(term) {
  return variationTerms.has(compact(term));
}

function variationTermTargets(term) {
  const normalizedTerm = compact(term);
  if (!normalizedTerm) return [];
  if (isVariationTerm(normalizedTerm)) return [normalizedTerm];
  return [...variationTerms].filter((variation) => variation.startsWith(normalizedTerm));
}

function isVariationIntentTerm(term) {
  const normalizedTerm = compact(term);
  if (!normalizedTerm) return false;
  return isVariationTerm(normalizedTerm) ||
    normalizedTerm === 'g' ||
    normalizedTerm === 'e' ||
    (normalizedTerm.length >= 2 && variationTermTargets(normalizedTerm).length > 0);
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

const expansionAliases = new Set([
  'col',
  'calllegends',
  'calloflegends',
  'hgss',
  'hgs',
  'heartgold',
  'soulsilver',
  'heartgoldsoulsilver',
  '151',
  'pokemon151',
  'pokemoncard151',
  'collect151',
  'cel',
  'pal',
  'obf',
  'obs',
  'svi',
  'sv',
]);

function nonNameCategoryPlan(searchTerm) {
  const terms = searchTerms(searchTerm);
  const tokens = terms.map((term, index) => {
    const categories = [];
    if (/^[0-9]+$/.test(term)) {
      categories.push('number', 'expansion');
    } else {
      if (isVariationIntentTerm(term)) categories.push('variation');
      if (isRarityTerm(term)) categories.push('rarity');
      if (expansionAliases.has(compact(term)) || (index > 0 && term.length >= 4)) {
        categories.push('expansion');
      }
      if (!isVariationIntentTerm(term) && !isRarityTerm(term) && term.length >= 2) {
        categories.push('trainer_or_variant');
      }
    }
    return { term, categories: [...new Set(categories)] };
  }).filter((token) => token.categories.length > 0);
  const categories = [...new Set(tokens.flatMap((token) => token.categories))];
  if (tokens.length === 0 || categories.length === 0) {
    return null;
  }
  return {
    strategy: 'non_name_category_fanout',
    tokens,
    categories,
  };
}

function cleanCategoryContext(value, category, token, searchLanguage) {
  const source = value?.non_name_context?.[category] || value?.nonNameContext?.[category];
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { valid: false, reason: 'missing_category_context' };
  }
  const previousQuery = cleanSearchTerm(source.query);
  const currentQuery = cleanSearchTerm(token.term);
  if (!previousQuery || !currentQuery.startsWith(previousQuery) || currentQuery === previousQuery) {
    return { valid: false, reason: 'category_query_not_extended' };
  }
  const language = cleanLanguage(source.language);
  if (language !== cleanLanguage(searchLanguage)) {
    return { valid: false, reason: 'category_language_changed' };
  }
  const createdAtMs = Number(source.created_at_ms ?? source.createdAtMs ?? 0);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || Date.now() - createdAtMs > 60_000) {
    return { valid: false, reason: 'category_context_expired' };
  }
  const cardIds = Array.isArray(source.card_ids ?? source.cardIds)
    ? (source.card_ids ?? source.cardIds)
      .map((id) => Number(id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  if (cardIds.length === 0) {
    return { valid: false, reason: 'empty_category_card_ids' };
  }
  if (cardIds.length > 500) {
    return { valid: false, reason: 'too_many_category_card_ids' };
  }
  return {
    valid: true,
    query: previousQuery,
    language,
    cardIds: [...new Set(cardIds)],
  };
}

function buildNonNameContext(searchLanguage, categorySteps) {
  const context = {};
  for (const step of categorySteps || []) {
    if (!step.category || !step.term || !Array.isArray(step.cardIds) || step.cardIds.length === 0) {
      continue;
    }
    const existing = context[step.category];
    if (existing && existing.card_ids.length >= step.cardIds.length) {
      continue;
    }
    context[step.category] = {
      query: step.term,
      language: cleanLanguage(searchLanguage),
      card_ids: step.cardIds.slice(0, 500).map((id) => String(id)),
      created_at_ms: Date.now(),
      strategy: step.strategy || 'category_sql',
    };
  }
  return context;
}

function nameSearchTimeoutMs() {
  const value = Number(process.env.MARKETPLACE_NAME_SEARCH_TIMEOUT_MS);
  if (!Number.isFinite(value)) {
    return 1500;
  }
  return Math.min(Math.max(Math.trunc(value), 250), 5000);
}

function nameSearchCircuitMs() {
  const value = Number(process.env.MARKETPLACE_NAME_SEARCH_CIRCUIT_MS);
  if (!Number.isFinite(value)) {
    return 60_000;
  }
  return Math.min(Math.max(Math.trunc(value), 5_000), 300_000);
}

function variationSearchTimeoutMs() {
  const value = Number(process.env.MARKETPLACE_VARIATION_SEARCH_TIMEOUT_MS);
  if (!Number.isFinite(value)) {
    return 1500;
  }
  return Math.min(Math.max(Math.trunc(value), 250), 5000);
}

function variationSearchCircuitMs() {
  const value = Number(process.env.MARKETPLACE_VARIATION_SEARCH_CIRCUIT_MS);
  if (!Number.isFinite(value)) {
    return 60_000;
  }
  return Math.min(Math.max(Math.trunc(value), 5_000), 300_000);
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

function debugEnabled(req) {
  return req.body?.debug === true || req.body?.debug === '1';
}

function rowSummary(row) {
  return {
    card_id: row.card_id,
    name: row.name,
    set_name: row.set_name,
    card_number: row.card_number,
    rarity: row.rarity,
    product_variant: row.product_variant,
    item_kind: row.item_kind,
    product_type: row.product_type,
    search_rank: Number(row.search_rank || 0),
  };
}

const searchCandidateSelect = `
  select
    c.card_id,
    c.ct_id,
    c.name,
    c.set_name,
    c.card_number,
    c.product_variant,
    c.rarity,
    c.card_type,
    c.item_kind,
    c.product_type,
    c.trainer_name,
    c.image_url,
    c.cdn_image_url,
    c.preview_image_url,
    c.homepage_image_url,
    c.card_palette,
    c.emoji,
    c.artist,
    c.illustrator,
    c.imported_at
`;

async function searchNonNameNumberWithDatabase(searchTerm, resultLimit, resultOffset = 0, query = marketplaceQuery) {
  const result = await query(
    `
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      hits as (
        select
          num.card_number,
          max(
            case
              when num.normalized_number = n.q then 1120
              when num.compact_number = n.compact_q then 1120
              when n.q = any(num.number_tokens) then 1080
              when n.q ~ '^[0-9]+$'
                and num.normalized_number ~ ('(^|[^0-9])' || regexp_replace(n.q, '([\\^$.|?*+()\\[\\]{}])', '\\\\1', 'g') || '([^0-9]|$)') then 1060
              when num.normalized_number like n.q || '%' then 860
              when num.compact_number like n.compact_q || '%' then 820
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_expansion_numbers num
          on num.normalized_number = n.q
          or num.compact_number = n.compact_q
          or n.q = any(num.number_tokens)
          or (
            n.q ~ '^[0-9]+$'
            and num.normalized_number ~ ('(^|[^0-9])' || regexp_replace(n.q, '([\\^$.|?*+()\\[\\]{}])', '\\\\1', 'g') || '([^0-9]|$)')
          )
          or num.normalized_number like n.q || '%'
          or num.compact_number like n.compact_q || '%'
        group by num.card_number
      )
      ${searchCandidateSelect},
        (h.token_score + 560 + c.search_weight)::real as search_rank
      from hits h
      join public.marketplace_search_candidates c on c.card_number = h.card_number
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    `,
    [searchTerm, resultLimit, resultOffset],
  );
  return result.rows;
}

async function searchNonNameVariationWithDatabase(searchTerm, resultLimit, resultOffset = 0, query = marketplaceQuery) {
  const result = await query(
    `
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      hits as (
        select
          v.variation_key,
          max(
            case
              when n.q = any(v.normalized_aliases) then 1180
              when n.compact_q = any(v.compact_aliases) then 1160
              when n.compact_q <> '' and exists (
                select 1
                from unnest(v.normalized_aliases, v.compact_aliases) as alias_pair(normalized_alias, compact_alias)
                where (
                  alias_pair.normalized_alias <> ''
                  and n.q ~ ('(^|[^a-z0-9])' || regexp_replace(alias_pair.normalized_alias, '([\\^$.|?*+()\\[\\]{}])', '\\\\1', 'g') || '([^a-z0-9]|$)')
                )
                or (
                  length(n.compact_q) >= 1
                  and length(alias_pair.compact_alias) >= 2
                  and alias_pair.compact_alias like n.compact_q || '%'
                )
              ) then 1320
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_variations v
          on n.q = any(v.normalized_aliases)
          or n.compact_q = any(v.compact_aliases)
          or exists (
            select 1
            from unnest(v.normalized_aliases, v.compact_aliases) as alias_pair(normalized_alias, compact_alias)
            where (
              alias_pair.normalized_alias <> ''
              and n.q ~ ('(^|[^a-z0-9])' || regexp_replace(alias_pair.normalized_alias, '([\\^$.|?*+()\\[\\]{}])', '\\\\1', 'g') || '([^a-z0-9]|$)')
            )
            or (
              length(n.compact_q) >= 1
              and length(alias_pair.compact_alias) >= 2
              and alias_pair.compact_alias like n.compact_q || '%'
            )
          )
        group by v.variation_key
      )
      ${searchCandidateSelect},
        (h.token_score + 1320 + c.search_weight)::real as search_rank
      from hits h
      join public.marketplace_card_variations cv on cv.variation_key = h.variation_key
      join public.marketplace_search_candidates c on c.card_id = cv.card_id
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    `,
    [searchTerm, resultLimit, resultOffset],
  );
  return result.rows;
}

async function searchNonNameExpansionWithDatabase(searchTerm, resultLimit, resultOffset = 0, query = marketplaceQuery) {
  const result = await query(
    `
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      expansion_hits as (
        select
          e.normalized_name as expansion_name,
          (
            case
              when e.normalized_name = n.q then 1050
              when e.compact_name = n.compact_q then 1030
              when length(n.q) >= 2 and e.normalized_name like n.q || '%' then 820
              when length(n.q) >= 2 and e.compact_name like n.compact_q || '%' then 780
              when length(n.q) >= 4 and e.normalized_name % n.q then 620 + similarity(e.normalized_name, n.q) * 180
              else 0
            end
          )::real as token_score
        from normalized n
        join public.pokoin_pokemon_expansions e
          on e.normalized_name = n.q
          or e.compact_name = n.compact_q
          or (length(n.q) >= 2 and e.normalized_name like n.q || '%')
          or (length(n.q) >= 2 and e.compact_name like n.compact_q || '%')
          or (length(n.q) >= 4 and e.normalized_name % n.q)
        union all
        select
          ea.normalized_expansion_name as expansion_name,
          (
            case
              when ea.normalized_alias = n.q then 1180
              when ea.compact_alias = n.compact_q then 1160
              else 0
            end
            + greatest(0, 220 - ea.priority)
          )::real as token_score
        from normalized n
        join public.marketplace_expansion_aliases ea
          on ea.normalized_alias = n.q
          or ea.compact_alias = n.compact_q
      ),
      hits as (
        select expansion_name, max(token_score) as token_score
        from expansion_hits
        group by expansion_name
      )
      ${searchCandidateSelect},
        (h.token_score + 980 + c.search_weight)::real as search_rank
      from hits h
      join public.marketplace_search_candidates c
        on public.marketplace_search_normalize(c.expansion_name) = h.expansion_name
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    `,
    [searchTerm, resultLimit, resultOffset],
  );
  return result.rows;
}

async function searchNonNameRarityWithDatabase(searchTerm, resultLimit, resultOffset = 0, query = marketplaceQuery) {
  const result = await query(
    `
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      ),
      rarity_hits as (
        select
          r.rarity,
          (
            case
              when r.normalized_rarity = n.q then 980
              when r.compact_rarity = n.compact_q then 940
              when r.normalized_rarity like n.q || '%' then 720
              when length(n.q) >= 4 and r.normalized_rarity % n.q then 560 + similarity(r.normalized_rarity, n.q) * 160
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_rarities r
          on r.normalized_rarity = n.q
          or r.compact_rarity = n.compact_q
          or r.normalized_rarity like n.q || '%'
          or (length(n.q) >= 4 and r.normalized_rarity % n.q)
      ),
      candidate_hits as (
        select c.card_id, max(h.token_score + 320)::real as token_score
        from rarity_hits h
        join public.marketplace_search_candidates c on c.rarity = h.rarity
        group by c.card_id
        union all
        select
          c.card_id,
          max(
            case
              when n.q = 'sir' and public.marketplace_search_normalize(c.card_number) like '%special illustration rare%' then 900
              when n.q in ('ir', 'ill', 'illus', 'illustration') and public.marketplace_search_normalize(c.card_number) like '%illustration rare%' then 820
              when n.q in ('ur', 'ultra') and public.marketplace_search_normalize(c.card_number) like '%ultra rare%' then 800
              when n.q in ('sr', 'secret') and public.marketplace_search_normalize(c.card_number) like '%secret rare%' then 780
              when n.q in ('rare', 'holo', 'shiny') and public.marketplace_search_normalize(c.card_number) like '%' || n.q || '%' then 520
              else 0
            end
          )::real as token_score
        from normalized n
        join public.marketplace_search_candidates c
          on (
            n.q = 'sir'
            and public.marketplace_search_normalize(c.card_number) like '%special illustration rare%'
          )
          or (
            n.q in ('ir', 'ill', 'illus', 'illustration')
            and public.marketplace_search_normalize(c.card_number) like '%illustration rare%'
          )
          or (
            n.q in ('ur', 'ultra')
            and public.marketplace_search_normalize(c.card_number) like '%ultra rare%'
          )
          or (
            n.q in ('sr', 'secret')
            and public.marketplace_search_normalize(c.card_number) like '%secret rare%'
          )
          or (
            n.q in ('rare', 'holo', 'shiny')
            and public.marketplace_search_normalize(c.card_number) like '%' || n.q || '%'
          )
        group by c.card_id
      )
      ${searchCandidateSelect},
        (h.token_score + c.search_weight)::real as search_rank
      from candidate_hits h
      join public.marketplace_search_candidates c on c.card_id = h.card_id
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    `,
    [searchTerm, resultLimit, resultOffset],
  );
  return result.rows;
}

async function searchNonNameTrainerVariantWithDatabase(searchTerm, resultLimit, resultOffset = 0, query = marketplaceQuery) {
  const result = await query(
    `
      with normalized as (
        select
          public.marketplace_search_normalize($1) as q,
          public.marketplace_search_compact($1) as compact_q,
          least(greatest($2::integer, 1), 15874) as clean_limit,
          least(greatest($3::integer, 0), 15874) as clean_offset
      )
      ${searchCandidateSelect},
        (
          case
            when public.marketplace_search_normalize(c.trainer_name) = n.q then 980
            when public.marketplace_search_compact(c.trainer_name) = n.compact_q then 940
            when public.marketplace_search_normalize(c.trainer_name) like n.q || '%' then 760
            when public.marketplace_search_compact(c.trainer_name) like n.compact_q || '%' then 720
            when public.marketplace_search_normalize(c.product_variant) = n.q then 860
            when public.marketplace_search_compact(c.product_variant) = n.compact_q then 840
            when public.marketplace_search_normalize(c.product_variant) like n.q || '%' then 700
            when public.marketplace_search_compact(c.product_variant) like n.compact_q || '%' then 680
            else 0
          end
          + 360
          + c.search_weight
        )::real as search_rank
      from normalized n
      join public.marketplace_search_candidates c
        on (
          c.trainer_name <> ''
          and (
            public.marketplace_search_normalize(c.trainer_name) = n.q
            or public.marketplace_search_compact(c.trainer_name) = n.compact_q
            or public.marketplace_search_normalize(c.trainer_name) like n.q || '%'
            or public.marketplace_search_compact(c.trainer_name) like n.compact_q || '%'
          )
        )
        or (
          c.product_variant <> ''
          and (
            public.marketplace_search_normalize(c.product_variant) = n.q
            or public.marketplace_search_compact(c.product_variant) = n.compact_q
            or public.marketplace_search_normalize(c.product_variant) like n.q || '%'
            or public.marketplace_search_compact(c.product_variant) like n.compact_q || '%'
          )
        )
      order by search_rank desc, c.name asc, c.card_number asc
      limit (select clean_limit from normalized)
      offset (select clean_offset from normalized)
    `,
    [searchTerm, resultLimit, resultOffset],
  );
  return result.rows;
}

function collectorNumberKey(value) {
  const match = String(value || '').match(/(\d+)\s*\/\s*(\d+)/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : '';
}

function rankRowsByQueryCollectorNumber(rows, searchTerm) {
  const wanted = collectorNumberKey(searchTerm);
  if (!wanted || !Array.isArray(rows) || rows.length < 2) {
    return rows;
  }
  return [...rows].sort((left, right) => {
    const leftMatch = collectorNumberKey(left?.card_number) === wanted ? 0 : 1;
    const rightMatch = collectorNumberKey(right?.card_number) === wanted ? 0 : 1;
    return leftMatch - rightMatch;
  });
}

async function searchRowsByCardIdsIdentity(cardIds, query = marketplaceQuery) {
  if (!cardIds.length) return [];
  const result = await query(
    `
      ${searchCandidateSelect},
        c.search_weight::real as search_rank
      from public.marketplace_search_candidates c
      where c.card_id = any($1::bigint[])
    `,
    [cardIds],
  );
  return result.rows.map((row) => ({
    ...row,
    canonical_path: row.canonical_path || canonicalPathForRow(row),
    canonicalPath: row.canonicalPath || canonicalPathForRow(row),
  }));
}

async function searchRowsByCardIdsWithDatabase(cardIds, query = marketplaceQuery) {
  if (!cardIds.length) return [];
  const result = await query(
    `
      ${searchCandidateSelect},
        c.search_weight::real as search_rank,
        coalesce(cardtrader.eligible_quantity, cardtrader.eligible_listing_count, 0) as listed_quantity,
        cardtrader.cheapest_price_pkn as lowest_price_pkn,
        case
          when cardtrader.provider = 'cardtrader'
            then coalesce(cardtrader.eligible_listing_count, 0)
          else 0
        end as cardtrader_eligible_listing_count,
        (cardtrader.provider = 'cardtrader' and coalesce(cardtrader.eligible_listing_count, 0) > 0) as has_cardtrader_listing,
        case
          when cardtrader.provider = 'cardtrader'
            then coalesce(cardtrader.eligible_quantity, 0)
          else 0
        end as cardtrader_listed_quantity
      from public.marketplace_search_candidates c
      left join lateral (
        select cardtrader_cache.*
        from public.cheapest_homepage_cache_blueprint cardtrader_cache
        where cardtrader_cache.provider in ('cardtrader', 'pokoin_native')
          and cardtrader_cache.eligible_listing_count > 0
          and cardtrader_cache.cheapest_price_pkn is not null
          and (
            cardtrader_cache.blueprint_id = c.ct_id
            or cardtrader_cache.pokoin_card_id = c.card_id::text
          )
        order by
          case when cardtrader_cache.blueprint_id = c.ct_id then 0 else 1 end,
          cardtrader_cache.cheapest_price_pkn asc,
          case when cardtrader_cache.provider = 'pokoin_native' then 0 else 1 end,
          cardtrader_cache.eligible_listing_count desc
        limit 1
      ) cardtrader on true
      where c.card_id = any($1::bigint[])
      order by c.search_weight desc, c.name asc, c.card_number asc
    `,
    [cardIds],
  );
  return result.rows;
}

function rowMatchesCategoryToken(row, category, token) {
  const term = token.term;
  const compactTerm = compact(term);
  if (!compactTerm) return false;
  if (category === 'number') {
    const number = String(row.card_number || '').toLowerCase();
    const numberTerms = searchTerms(number);
    const compactNumber = compact(number);
    return numberTerms.includes(term) ||
      compactNumber === compactTerm ||
      compactNumber.startsWith(compactTerm) ||
      compactNumber.includes(compactTerm);
  }
  if (category === 'variation') {
    const text = [
      row.name,
      row.rarity,
      row.card_type,
      row.product_type,
      row.product_variant,
    ].join(' ').toLowerCase();
    return variationTermTargets(compactTerm).some((target) => {
      if (target === 'v') return /(^|[^a-z0-9])v([^a-z0-9]|$)/.test(text);
      if (target === 'lvx') return /(^|[^a-z0-9])(lv\.?x|level x)([^a-z0-9]|$)/.test(text);
      if (target === 'mega') return /(^|[^a-z0-9])(mega|m)([^a-z0-9]|$)/.test(text);
      return new RegExp(`(^|[^a-z0-9])${target}([^a-z0-9]|$)`).test(text);
    });
  }
  if (category === 'expansion') {
    const set = String(row.set_name || '').toLowerCase();
    const compactSet = compact(set);
    return searchTerms(set).includes(term) ||
      compactSet.includes(compactTerm) ||
      (term.length >= 4 && compactSet.startsWith(compactTerm.slice(0, 4)));
  }
  if (category === 'rarity') {
    const text = [row.rarity, row.card_number].join(' ').toLowerCase();
    if (compactTerm === 'sir') return text.includes('special illustration rare');
    if (compactTerm === 'ir' || compactTerm === 'ill' || compactTerm === 'illus') {
      return text.includes('illustration rare');
    }
    return compact(text).includes(compactTerm);
  }
  if (category === 'trainer_or_variant') {
    const text = [row.trainer_name, row.product_variant].join(' ').toLowerCase();
    const compactText = compact(text);
    return searchTerms(text).includes(term) || compactText.includes(compactTerm);
  }
  return false;
}

async function searchNonNameCategoryWithContext(
  category,
  token,
  resultLimit,
  searchLanguage,
  previousContext,
  query = marketplaceQuery,
) {
  const context = cleanCategoryContext(previousContext, category, token, searchLanguage);
  if (!context.valid) {
    return { rows: null, context, strategy: 'category_context_invalid' };
  }
  const rows = await searchRowsByCardIdsWithDatabase(context.cardIds, query);
  const matchedRows = rows
    .filter((row) => rowMatchesCategoryToken(row, category, token))
    .map((row) => ({
      ...row,
      search_rank: Number(row.search_rank || 0) + 1800,
    }))
    .sort((left, right) =>
      Number(right.search_rank || 0) - Number(left.search_rank || 0) ||
      String(left.name || '').localeCompare(String(right.name || '')) ||
      String(left.card_number || '').localeCompare(String(right.card_number || '')))
    .slice(0, resultLimit);
  return {
    rows: matchedRows.length > 0 ? matchedRows : null,
    context,
    strategy: 'category_context_refine',
  };
}

async function timed(label, fn, debug) {
  const started = Date.now();
  try {
    const rows = await fn();
    if (debug) {
      debug.steps.push({
        label,
        durationMs: Date.now() - started,
        rowCount: rows.length,
        topRows: rows.slice(0, 8).map(rowSummary),
      });
    }
    return rows;
  } catch (error) {
    if (debug) {
      debug.steps.push({
        label,
        durationMs: Date.now() - started,
        error: error.message || String(error),
        code: error.code,
      });
    }
    throw error;
  }
}

async function searchWithDatabase(searchTerm, resultLimit, resultOffset, searchLanguage = 'en') {
  const result = await marketplaceQuery(
    `select * from public.${SEARCH_RPC_V2}($1, $2, $3, $4)`,
    [searchTerm, resultLimit, resultOffset, cleanLanguage(searchLanguage)],
  );
  return result.rows;
}

async function searchNameWithDatabase(searchTerm, resultLimit, resultOffset, searchLanguage = 'en') {
  const result = await marketplaceNameSearchQuery(
    `select * from public.${SEARCH_NAME_RPC}($1, $2, $3, $4)`,
    [searchTerm, resultLimit, resultOffset, cleanLanguage(searchLanguage)],
  );
  return result.rows;
}

async function searchNonNameWithDatabaseLegacy(searchTerm, resultLimit, resultOffset, searchLanguage = 'en') {
  const result = await marketplaceQuery(
    `select * from public.${SEARCH_NON_NAME_RPC}($1, $2, $3, $4)`,
    [searchTerm, resultLimit, resultOffset, cleanLanguage(searchLanguage)],
  );
  return result.rows;
}

async function searchNonNameWithDatabase(
  searchTerm,
  resultLimit,
  resultOffset,
  searchLanguage = 'en',
  debug = null,
  query = marketplaceQuery,
  previousContext = null,
) {
  const plan = nonNameCategoryPlan(searchTerm);
  if (!plan) {
    if (debug) {
      debug.nonNameCategoryFanout = {
        used: false,
        reason: 'empty_plan',
      };
    }
    return searchNonNameWithDatabaseLegacy(searchTerm, resultLimit, resultOffset, searchLanguage);
  }
  const cleanLimitValue = cleanLimit(resultLimit);
  const cleanOffsetValue = cleanOffset(resultOffset);
  const started = Date.now();
  const queryLabel = query === marketplaceVariationSearchQuery ? 'replica' : 'primary';
  try {
    const rowGroups = [];
    const categorySteps = [];
    const runCategory = async (category, token, fn) => {
      const categoryStarted = Date.now();
      const refined = await searchNonNameCategoryWithContext(
        category,
        token,
        cleanLimitValue,
        searchLanguage,
        previousContext,
        query,
      );
      const rows = refined.rows ||
        await fn(token.term, cleanLimitValue, cleanOffsetValue, query);
      categorySteps.push({
        category,
        term: token.term,
        strategy: refined.rows ? refined.strategy : 'category_sql',
        database: queryLabel,
        contextReason: refined.rows ? undefined : refined.context.reason,
        durationMs: Date.now() - categoryStarted,
        rowCount: rows.length,
        cardIds: rows.map((row) => row.card_id).filter(Boolean).slice(0, 500),
        topRows: rows.slice(0, 5).map(rowSummary),
      });
      rowGroups.push(rows);
    };
    const tasks = [];
    for (const token of plan.tokens) {
      if (token.categories.includes('number')) {
        tasks.push(runCategory('number', token, searchNonNameNumberWithDatabase));
      }
      if (token.categories.includes('variation')) {
        tasks.push(runCategory('variation', token, searchNonNameVariationWithDatabase));
      }
      if (token.categories.includes('expansion')) {
        tasks.push(runCategory('expansion', token, searchNonNameExpansionWithDatabase));
      }
      if (token.categories.includes('rarity')) {
        tasks.push(runCategory('rarity', token, searchNonNameRarityWithDatabase));
      }
      if (token.categories.includes('trainer_or_variant')) {
        tasks.push(runCategory('trainer_or_variant', token, searchNonNameTrainerVariantWithDatabase));
      }
    }
    await Promise.all(tasks);
    const merged = mergeSearchRows(rowGroups, cleanLimitValue);
    if (debug) {
      debug.nonNameCategoryFanout = {
        used: true,
        strategy: plan.strategy,
        database: queryLabel,
        categories: plan.categories,
        tokens: plan.tokens,
        durationMs: Date.now() - started,
        rowCount: merged.length,
        context: buildNonNameContext(searchLanguage, categorySteps),
        steps: categorySteps.sort((left, right) =>
          left.category.localeCompare(right.category) || left.term.localeCompare(right.term)),
      };
    }
    if (merged.length > 0) {
      return merged;
    }
    if (debug) {
      debug.nonNameCategoryFanout.fallbackReason = 'empty_category_fanout';
    }
    return searchNonNameWithDatabaseLegacy(searchTerm, resultLimit, resultOffset, searchLanguage);
  } catch (error) {
    if (debug) {
      debug.nonNameCategoryFanout = {
        used: false,
        strategy: plan.strategy,
        categories: plan.categories,
        tokens: plan.tokens,
        durationMs: Date.now() - started,
        fallbackReason: error.message || String(error),
        code: error.code,
      };
    }
    return searchNonNameWithDatabaseLegacy(searchTerm, resultLimit, resultOffset, searchLanguage);
  }
}

function mergeSearchRows(rowGroups, resultLimit) {
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

async function searchVariationReplicaNonNameWithDatabase(
  searchTerm,
  resultLimit,
  resultOffset,
  searchLanguage = 'en',
  debug = null,
  previousContext = null,
  primaryQuery = marketplaceQuery,
  replicaQuery = marketplaceVariationSearchQuery,
) {
  if (Date.now() < variationSearchDisabledUntil) {
    if (debug) {
      debug.variationSearch = {
        path: 'primary_circuit_open',
        disabledUntil: variationSearchDisabledUntil,
      };
    }
    return searchNonNameWithDatabase(
      searchTerm,
      resultLimit,
      resultOffset,
      searchLanguage,
      debug,
      primaryQuery,
      previousContext,
    );
  }
  try {
    const rows = await withTimeout(
      searchNonNameWithDatabase(
        searchTerm,
        resultLimit,
        resultOffset,
        searchLanguage,
        debug,
        replicaQuery,
        previousContext,
      ),
      variationSearchTimeoutMs(),
      'variation search replica',
    );
    if (debug) {
      debug.variationSearch = {
        path: 'replica',
        timeoutMs: variationSearchTimeoutMs(),
        rowCount: rows.length,
      };
    }
    return rows;
  } catch (error) {
    variationSearchDisabledUntil = Date.now() + variationSearchCircuitMs();
    console.error('variation marketplace search failed; falling back to primary non-name search', error);
    if (debug) {
      debug.variationSearch = {
        path: 'primary_fallback',
        reason: error.message || String(error),
        code: error.code,
        disabledUntil: variationSearchDisabledUntil,
      };
    }
    return searchNonNameWithDatabase(
      searchTerm,
      resultLimit,
      resultOffset,
      searchLanguage,
      debug,
      primaryQuery,
      previousContext,
    );
  }
}

async function rowsForSplitSearchTerm(
  searchTerm,
  resultLimit,
  resultOffset = 0,
  searchLanguage = 'en',
  debug = null,
  previousContext = null,
) {
  const cleanLang = cleanLanguage(searchLanguage);
  const poolLimit = Math.min(Math.max(resultLimit * 2, resultLimit), 15874);
  if (debug) {
    debug.searchPath = 'split';
    debug.poolLimit = poolLimit;
    debug.nameSearchDisabledUntil = nameSearchDisabledUntil;
    debug.variationSearchDisabledUntil = variationSearchDisabledUntil;
  }
  if (Date.now() < nameSearchDisabledUntil) {
    if (debug) {
      debug.searchPath = 'primary_full_circuit_open';
    }
    return timed(
      'primary_full_circuit_open',
      () => searchWithDatabase(searchTerm, resultLimit, resultOffset, cleanLang),
      debug,
    );
  }
  try {
    const [nameRows, nonNameRows] = await Promise.all([
      timed(
        'peer3_name',
        () => withTimeout(
          searchNameWithDatabase(searchTerm, poolLimit, resultOffset, cleanLang),
          nameSearchTimeoutMs(),
          'peer3 name search',
        ),
        debug,
      ),
      timed(
        'variation_non_name',
        () => searchVariationReplicaNonNameWithDatabase(
          searchTerm,
          poolLimit,
          resultOffset,
          cleanLang,
          debug,
          previousContext,
        ),
        debug,
      ),
    ]);
    const merged = mergeSearchRows([nameRows, nonNameRows], resultLimit);
    if (debug?.nonNameCategoryFanout?.context) {
      merged.nonNameContext = debug.nonNameCategoryFanout.context;
    }
    if (debug) {
      debug.merged = {
        rowCount: merged.length,
        topRows: merged.slice(0, 8).map(rowSummary),
      };
    }
    return merged;
  } catch (error) {
    nameSearchDisabledUntil = Date.now() + nameSearchCircuitMs();
    console.error('split marketplace search failed; falling back to primary full search', error);
    if (debug) {
      debug.searchPath = 'primary_full_fallback';
      debug.fallback = {
        reason: error.message || String(error),
        code: error.code,
        disabledUntil: nameSearchDisabledUntil,
      };
    }
    return timed(
      'primary_full_fallback',
      () => searchWithDatabase(searchTerm, resultLimit, resultOffset, cleanLang),
      debug,
    );
  }
}

/** Attach compact theme packs (`vt`) to search/typeahead rows so result →
 * desk navigation can paint themed before the card-page payload lands.
 * Failure-safe: hints must never break search. */
async function attachThemePacks(rows, overlay = sql) {
  if (!Array.isArray(rows) || !rows.length) {
    return rows;
  }
  try {
    const ids = [...new Set(rows.map((row) => String(row.card_id || row.id || '')).filter((id) => /^\d+$/.test(id)))];
    const packs = await overlay.readCardThemePacks(ids);
    if (!packs.size) {
      return rows;
    }
    return rows.map((row) => {
      const id = String(row.card_id || row.id || '');
      const vt = packs.get(id);
      return vt ? { ...row, vt } : row;
    });
  } catch (_) {
    return rows;
  }
}

async function rowsForSearchTerm(
  searchTerm,
  resultLimit,
  resultOffset = 0,
  searchLanguage = 'en',
  debug = null,
  previousContext = null,
  options = {},
) {
  const loaded = await rowsForSearchTermBase(
    searchTerm,
    resultLimit,
    resultOffset,
    searchLanguage,
    debug,
    previousContext,
    options,
  );
  if (options.withTotal === true) {
    // withTotal contract: { rows, total } where total answers the SAME
    // predicate as rows (Meili estimatedTotalHits for the candidates query,
    // null when only the legacy SQL engine ran). rows must be a real array
    // once this promise settles — attachThemePacks is async, and callers
    // call .filter on rows directly.
    if (loaded && !Array.isArray(loaded)) {
      return { rows: await attachThemePacks(loaded.rows || []), total: Number(loaded.total) || 0 };
    }
    return { rows: await attachThemePacks(Array.isArray(loaded) ? loaded : []), total: null };
  }
  return attachThemePacks(loaded);
}

async function rowsForSearchTermBase(
  searchTerm,
  resultLimit,
  resultOffset = 0,
  searchLanguage = 'en',
  debug = null,
  previousContext = null,
  options = {},
) {
  const meiliOnly = Boolean(options.meiliOnly);
  if (useMeiliSearchForLanguage(searchLanguage)) {
    if (debug) {
      debug.searchPath = 'meili_en_candidates';
    }
    try {
      const loaded = await rowsForMeiliSearchTerm(
        searchTerm,
        resultLimit,
        resultOffset,
        searchLanguage,
        debug,
        previousContext,
        options,
      );
      if (marketplaceSearchShadowEnabled()) {
        rowsForSplitSearchTerm(
          searchTerm,
          resultLimit,
          resultOffset,
          searchLanguage,
          null,
          previousContext,
        ).catch((error) => {
          console.error('legacy shadow search failed', error?.message || error);
        });
      }
      return options.withTotal === true
        ? { rows: loaded.rows, total: Number(loaded.total) || 0 }
        : loaded.rows;
    } catch (error) {
      if (debug) {
        debug.searchPath = meiliOnly ? 'meili_en_unavailable' : 'meili_en_fallback_legacy';
        debug.searchEngine = {
          mode: marketplaceSearchEngine(),
          fallback: meiliOnly ? 'caller' : 'legacy',
          reason: error.message || String(error),
          code: error.code,
        };
      }
      console.error(
        meiliOnly
          ? 'meili search failed; caller will choose fallback path'
          : 'meili search failed, falling back to legacy search',
        error,
      );
      if (meiliOnly) {
        return [];
      }
    }
  }
  if (meiliOnly) {
    if (debug) {
      debug.searchEngine = {
        mode: marketplaceSearchEngine(),
        language: searchLanguage,
        active: false,
        fallback: 'caller',
        reason: 'language_gate_or_flag',
      };
    }
    return options.withTotal === true ? { rows: [], total: 0 } : [];
  }
  if (debug) {
    debug.searchEngine = {
      mode: marketplaceSearchEngine(),
      language: searchLanguage,
      active: false,
      reason: 'language_gate_or_flag',
    };
  }
  return rowsForSplitSearchTerm(
    searchTerm,
    resultLimit,
    resultOffset,
    searchLanguage,
    debug,
    previousContext,
  );
}

async function rowsForMeiliSearchTerm(
  searchTerm,
  resultLimit,
  resultOffset = 0,
  searchLanguage = 'en',
  debug = null,
  previousContext = null,
  options = {},
) {
  const pageSize = Math.min(Math.max(Math.trunc(Number(resultLimit) || 100), 1), 100);
  const pageOffset = Math.min(Math.max(Math.trunc(Number(resultOffset) || 0), 0), 10000);
  // Rows and total come from ONE candidates query (q + filters + match=all).
  // The suggest hot pool is deliberately not reused here: it is a different
  // universe (name/number search-on, relaxed strategy), so serving it as
  // search rows would detach the result count from the result predicate.
  const candidateLoad = await meiliMarketplaceCandidates(
    searchTerm,
    searchLanguage,
    pageSize,
    pageOffset,
    { printLanguage: options.printLanguage || 'all' },
  );
  const meiliCandidates = candidateLoad.hits;
  const ids = meiliCandidates.map((candidate) => String(candidate.card_id)).filter(Boolean);
  const lightHydrate = options.lightHydrate === true;
  const hydratedRows = lightHydrate
    ? await searchRowsByCardIdsIdentity(ids)
    : await searchRowsByCardIdsWithDatabase(ids);
  const byId = new Map(hydratedRows.map((row) => [String(row.card_id), row]));
  const merged = rankRowsByQueryCollectorNumber(
    ids.map((id, index) => {
      const row = byId.get(id);
      if (!row) return null;
      const meili = meiliCandidates[index];
      return {
        ...row,
        search_rank: Number(meili?.meili_rank || 0),
      };
    }).filter(Boolean),
    searchTerm,
  ).slice(0, pageSize);
  if (debug) {
    debug.searchPath = 'meili_en_candidates';
    debug.tokenPlan = {
      strategy: debug.searchPath,
      poolLimit: pageSize,
      candidateCount: meiliCandidates.length,
      hydratedCount: hydratedRows.length,
      offset: pageOffset,
    };
    debug.searchEngine = {
      mode: 'meili',
      strategy: 'all',
      poolLimit: pageSize,
      offset: pageOffset,
      candidateCount: meiliCandidates.length,
      hydratedCount: hydratedRows.length,
      shadow: marketplaceSearchShadowEnabled(),
    };
    if (previousContext?.non_name_context || previousContext?.nonNameContext) {
      debug.searchEngine.contextIgnored = true;
    }
  }
  return { rows: merged, total: Number(candidateLoad.estimatedTotalHits) || 0 };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const searchTerm = cleanSearchTerm(req.body?.search_term ?? req.body?.searchTerm);
    const resultLimit = cleanLimit(req.body?.result_limit ?? req.body?.limit);
    const resultOffset = cleanOffset(req.body?.result_offset ?? req.body?.offset);
    const searchLanguage = cleanLanguage(req.body?.search_language ?? req.body?.language);
    const wantsDebug = debugEnabled(req);
    const debugUser = wantsDebug ? await authorizeSearchDebugRequest(req) : null;
    const debug = wantsDebug
      ? {
          sessionId: cleanSearchTerm(req.body?.debug_session_id),
          user: debugUser,
          searchTerm,
          resultLimit,
          resultOffset,
          searchLanguage,
          steps: [],
        }
      : null;
    if (!searchTerm) {
      return res.status(200).json(debug ? { rows: [], debug } : []);
    }

    const started = Date.now();
    const previousSearchContext = req.body?.previous_search_context ?? req.body?.previousSearchContext;
    const rows = (await rowsForSearchTerm(
      searchTerm,
      resultLimit,
      resultOffset,
      searchLanguage,
      debug,
      previousSearchContext,
    )).map(withCardEmojiFields);
    const durationMs = Date.now() - started;
    if (debug) {
      debug.durationMs = durationMs;
      debug.topRows = rows.slice(0, 10).map(rowSummary);
    }
    res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=20');
    res.setHeader('Server-Timing', `search;dur=${durationMs}`);
    return res.status(200).json(debug ? { rows, debug } : rows);
  } catch (error) {
    console.error('marketplace-search-candidates failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace search candidate fetch failed.',
    });
  }
};

module.exports.rowsForSearchTerm = rowsForSearchTerm;
module.exports.attachThemePacks = attachThemePacks;
module.exports.mergeSearchRows = mergeSearchRows;
module.exports.rowsForSplitSearchTerm = rowsForSplitSearchTerm;
module.exports.searchNameWithDatabase = searchNameWithDatabase;
module.exports.searchNonNameWithDatabase = searchNonNameWithDatabase;
module.exports.searchVariationReplicaNonNameWithDatabase = searchVariationReplicaNonNameWithDatabase;
module.exports.searchNonNameWithDatabaseLegacy = searchNonNameWithDatabaseLegacy;
module.exports.nonNameCategoryPlan = nonNameCategoryPlan;
module.exports.searchNonNameNumberWithDatabase = searchNonNameNumberWithDatabase;
module.exports.searchNonNameVariationWithDatabase = searchNonNameVariationWithDatabase;
module.exports.searchNonNameExpansionWithDatabase = searchNonNameExpansionWithDatabase;
module.exports.searchNonNameRarityWithDatabase = searchNonNameRarityWithDatabase;
module.exports.searchNonNameTrainerVariantWithDatabase = searchNonNameTrainerVariantWithDatabase;
module.exports.searchNonNameCategoryWithContext = searchNonNameCategoryWithContext;
module.exports.collectorNumberKey = collectorNumberKey;
module.exports.rankRowsByQueryCollectorNumber = rankRowsByQueryCollectorNumber;
module.exports.buildNonNameContext = buildNonNameContext;
module.exports.searchWithDatabase = searchWithDatabase;
module.exports.rowsForMeiliSearchTerm = rowsForMeiliSearchTerm;
module.exports.searchRowsByCardIdsIdentity = searchRowsByCardIdsIdentity;
module.exports.cleanSearchTerm = cleanSearchTerm;
module.exports.cleanLimit = cleanLimit;
module.exports.cleanLanguage = cleanLanguage;
module.exports.searchTerms = searchTerms;
module.exports.isVariationIntentTerm = isVariationIntentTerm;
module.exports.rowSummary = rowSummary;
module.exports.compact = compact;
module.exports.foldDiacritics = foldDiacritics;
