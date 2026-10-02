const { marketplaceQuery } = require('./_marketplace_db');
const { recordVersionImages } = require('./_marketplace_image_log');
const { withCardEmojiFields } = require('./_marketplace_card_emoji');
const { projectedRaritySql } = require('./_marketplace_card_rarity');
const {
  slugPart,
  slugParts: normalizedSlugParts,
} = require('./_slug');
const {
  availabilityColumns,
  cardTraderAvailabilityJoin,
  cheapestHomepageCacheRelationName,
} = require('./marketplace-cards');

function cleanLimit(value, fallback = 240) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanProductCategory(value) {
  const category = cleanText(value, 60).toLowerCase();
  return category === 'graded' ? category : '';
}

function searchTerms(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b([a-z0-9]+)s\b/g, "$1's")
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 || /^[0-9]+$/.test(term));
}

function cleanLanguage(value) {
  const language = String(value || 'en').trim().toLowerCase();
  if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) {
    return language;
  }
  return 'en';
}

function cardIdFromDoubledId(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) {
    return '';
  }
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric % 2 !== 0) {
    return '';
  }
  return String(numeric / 2);
}

function pokoinOurId(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) {
    return '';
  }
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return '';
  }
  return String(numeric % 2 === 1 ? numeric * 2 : numeric);
}

function resolveCardRoute({ cardId, cardSlug, doubledCardId }) {
  const cleanCardSlug = cleanText(cardSlug, 240);
  const pathOurId = cleanText(doubledCardId, 80);
  const cleanCardId = cleanText(cardId, 80);
  return {
    cardId: pathOurId || cleanCardId,
    cardSlug: cleanCardSlug,
  };
}

function normalizedCollectorNumberSql(column) {
  return `coalesce(
    substring(${column} from '([A-Za-z]*[0-9]+[A-Za-z]?\\s*/\\s*[0-9]+)'),
    substring(${column} from '([A-Za-z]{1,4}\\s*[0-9]+)'),
    ${column}
  )`;
}

const DETAIL_CLASSIFIER_PREFIXES = new Set([
  'card',
  'fixed',
  'common',
  'uncommon',
  'rare',
  'holo',
  'ultra',
  'secret',
  'promo',
  'product',
  'trading',
]);

function projectedExpansionNumberSql() {
  const cleanCollectorValue = (expression) => `nullif(
    nullif(
      nullif(regexp_replace(btrim(coalesce(${expression}, '')), '^#+\\s*', ''), ''),
      versions.card_id::text
    ),
    versions.blueprint_id::text
  )`;
  const imageCollectorNumber = (column) => `replace(
    substring(coalesce(${column}, '') from '([0-9]{1,4}[A-Za-z]?[-/][0-9]{1,4})'),
    '-',
    '/'
  )`;
  return `coalesce(
    ${cleanCollectorValue('versions.expansion_number')},
    ${cleanCollectorValue('candidates.card_number')},
    ${cleanCollectorValue('verified_links.collector_number')},
    ${cleanCollectorValue('product_parsing.collector_number')},
    ${cleanCollectorValue("blueprints.blueprint#>>'{fixed_properties,collector_number}'")},
    ${cleanCollectorValue("blueprints.blueprint->>'collector_number'")},
    ${cleanCollectorValue("blueprints.blueprint->>'number'")},
    ${cleanCollectorValue("blueprints.blueprint->>'card_number'")},
    ${cleanCollectorValue('blueprints.version')},
    ${cleanCollectorValue(imageCollectorNumber('versions.preview_image_url'))},
    ${cleanCollectorValue(imageCollectorNumber('versions.homepage_image_url'))},
    ${cleanCollectorValue(imageCollectorNumber('versions.cdn_image_url'))},
    ${cleanCollectorValue(imageCollectorNumber('versions.image_url'))}
  )`;
}

function projectedExpansionNumberIntSql(expansionNumberSql = projectedExpansionNumberSql()) {
  return `nullif(substring(${expansionNumberSql} from '([0-9]+)'), '')::integer`;
}

function cardDetailSlugParts(value) {
  return normalizedSlugParts(value);
}

function normalizeCollectorNumberSlugToken(value) {
  return String(value || '').replace(/^0+(?=[0-9])/, '');
}

function isCollectorNumberSlugToken(value) {
  return /^[0-9]+[a-z]?$/.test(value);
}

function collectorNumberTokenVariants(value) {
  if (!isCollectorNumberSlugToken(value)) {
    return [];
  }
  const normalized = normalizeCollectorNumberSlugToken(value);
  return Array.from(new Set([value, normalized])).filter(Boolean);
}

function stripLeadingClassifierTerms(terms) {
  const stripped = [...terms];
  while (stripped.length > 1 && DETAIL_CLASSIFIER_PREFIXES.has(stripped[0])) {
    stripped.shift();
  }
  return stripped;
}

function slugSql(column) {
  return `trim(both '-' from regexp_replace(replace(lower(coalesce(${column}, '')), 'é', 'e'), '[^a-z0-9]+', '-', 'g'))`;
}

function canonicalSlugForRow(row = {}) {
  const parts = [
    String(row.rarity || '').trim() || 'Card',
    row.name,
    row.expansion_number,
    row.expansion_name,
  ];
  return parts.map(slugPart).filter(Boolean).join('-');
}

function canonicalPathForRow(row = {}) {
  return String(row.canonical_path || row.canonicalPath || '').trim();
}

function canonicalSlugMatches(left, right) {
  const leftParts = stripLeadingClassifierTerms(cardDetailSlugParts(left));
  const rightParts = stripLeadingClassifierTerms(cardDetailSlugParts(right));
  if (!leftParts.length || !rightParts.length) {
    return false;
  }
  const normalizeParts = (parts) => parts.map((part) => {
    if (!/^[0-9]+[a-z]?$/.test(part)) {
      return part;
    }
    return normalizeCollectorNumberSlugToken(part);
  });
  return normalizeParts(leftParts).join('-') === normalizeParts(rightParts).join('-');
}

function collectorSlugSql(column) {
  return `trim(both '-' from regexp_replace(regexp_replace(replace(lower(coalesce(${column}, '')), 'é', 'e'), '\\y0+([0-9])', '\\1', 'g'), '[^a-z0-9]+', '-', 'g'))`;
}

function slugMatchClause(slug, values, options = {}) {
  const parsedTerms = cardDetailSlugParts(slug);
  const terms = options.ignoreLeadingClassifier
    ? stripLeadingClassifierTerms(parsedTerms)
    : parsedTerms;
  if (terms.length === 0) {
    return '';
  }
  const collectorNumberSql = options.collectorNumberSql || 'versions.expansion_number';
  return ` and ${terms.map((term) => {
    values.push(`%${term}%`);
    const placeholder = `$${values.length}`;
    const fieldMatch = (field) => `${slugSql(field)} ilike ${placeholder}`;
    const variants = collectorNumberTokenVariants(term);
    const collectorPlaceholders = variants.map((variant) => {
      values.push(`(^|-)${variant}(-|$)`);
      return `$${values.length}`;
    });
    const collectorFieldMatch = collectorPlaceholders
      .map((placeholder) => `${slugSql(collectorNumberSql)} ~ ${placeholder}`)
      .concat(
        collectorPlaceholders.map(
          (placeholder) => `${collectorSlugSql(collectorNumberSql)} ~ ${placeholder}`,
        ),
      )
      .join(' or ');
    return `(${[
      fieldMatch('versions.name'),
      fieldMatch('versions.expansion_name'),
      collectorFieldMatch,
      fieldMatch('coalesce(candidates.rarity, versions.product_variant)'),
      fieldMatch('candidates.card_type'),
    ].filter(Boolean).join('\n      or ')})`;
  }).join(' and ')}`;
}

function normalCollectorSql(column) {
  const normalized = normalizedCollectorNumberSql(column);
  return `case
    when ${normalized} ~ '^\\s*[0-9]+[A-Za-z]?\\s*(/[0-9]+)?\\s*$'
    then 0
    else 1
  end`;
}

function searchClause(query, productType, searchLanguage, values) {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return '';
  }
  const fields = productType
    ? ['versions.name', 'versions.expansion_name', 'versions.product_variant', 'versions.trainer_name']
    : [
        'versions.name',
        'versions.expansion_name',
        'versions.trainer_name',
        'versions.expansion_number',
      ];
  const clauses = terms.map((term) => {
    values.push(`%${term}%`);
    const placeholder = `$${values.length}`;
    values.push(cleanLanguage(searchLanguage));
    const languagePlaceholder = `$${values.length}`;
    return `(${fields.map((field) => `${field} ilike ${placeholder}`).join(' or ')}
      or exists (
        select 1
        from public.marketplace_card_name_translations translations
        where translations.language = ${languagePlaceholder}
          and translations.name = versions.name
          and translations.localized_name ilike ${placeholder}
      ))`;
  });
  return ` and ${clauses.join(' and ')}`;
}

function activeNativeListingPredicate(alias = 'listing') {
  return `
    ${alias}.status = 'active'
    and coalesce(${alias}.quantity_available, 0) > 0
    and ${alias}.price_pkn > 0
    and coalesce(${alias}.shipping_available, true) = true
    and not (
      ${alias}.nft_available = true
      and coalesce(${alias}.shipping_available, false) = false
    )
  `;
}

function gradedListingSummaryJoin(candidateAlias = 'versions') {
  return `
    left join lateral (
      select
        count(*)::integer as active_listing_count,
        coalesce(sum(coalesce(listing.quantity_available, 0)), 0)::integer as listed_quantity,
        min(listing.price_pkn) as lowest_price_pkn,
        (array_agg(listing.id::text order by listing.price_pkn asc, listing.updated_at desc, listing.id asc))[1] as sample_listing_id,
        (array_agg(nullif(listing.grading_company, '') order by listing.price_pkn asc, listing.updated_at desc, listing.id asc))[1] as grading_company,
        (array_agg(nullif(listing.grade, '') order by listing.price_pkn asc, listing.updated_at desc, listing.id asc))[1] as grade
      from (
        select
          native_listing.*,
          case when native_listing.card_id ~ '^[0-9]+$' then native_listing.card_id::bigint else null end as card_id_bigint
        from public.marketplace_user_listings native_listing
      ) listing
      where listing.card_id_bigint = ${candidateAlias}.card_id
        and listing.graded = true
        and ${activeNativeListingPredicate('listing')}
    ) graded_listings on true
  `;
}

function gradedAvailabilityColumns(alias = 'graded_listings') {
  return `
    coalesce(${alias}.listed_quantity, 0) as listed_quantity,
    ${alias}.lowest_price_pkn as lowest_price_pkn,
    case
      when coalesce(${alias}.active_listing_count, 0) > 0
        then 'marketplace_user_listings_graded'
      else null
    end as homepage_cheapest_source,
    case
      when coalesce(${alias}.active_listing_count, 0) > 0
        then 'pokoin_native'
      else null
    end as homepage_cheapest_provider,
    ${alias}.sample_listing_id as homepage_cheapest_listing_id,
    0 as cardtrader_eligible_listing_count,
    false as has_cardtrader_listing,
    0 as cardtrader_listed_quantity,
    null::numeric as cardtrader_lowest_price_pkn,
    false as cardtrader_available,
    true as is_graded,
    ${alias}.active_listing_count as graded_listing_count,
    ${alias}.lowest_price_pkn as graded_lowest_price_pkn,
    ${alias}.grading_company,
    ${alias}.grade
  `;
}

async function candidateRowsForCardId(cardId, query = marketplaceQuery) {
  const normalizedCardId = Number(cardId);
  if (!Number.isSafeInteger(normalizedCardId) || normalizedCardId <= 0) {
    return [];
  }
  const cheapestCacheRelation = await cheapestHomepageCacheRelationName(query);
  const raritySql = projectedRaritySql({
    rarityColumn: 'candidates.rarity',
    collectorNumberSql: 'candidates.card_number',
  });

  const result = await query(
    `
      select
        candidates.card_id,
        candidates.name,
        candidates.set_name as expansion_name,
        candidates.card_number as expansion_number,
        nullif(substring(candidates.card_number from '([0-9]+)'), '')::integer as expansion_number_int,
        candidates.product_variant,
        coalesce(candidates.ct_id, candidates.card_id) as blueprint_id,
        candidates.image_url,
        candidates.cdn_image_url,
        candidates.preview_image_url,
        candidates.homepage_image_url,
        candidates.product_type,
        candidates.trainer_name,
        candidates.card_palette,
        candidates.emoji,
        artist.artist,
        artist.illustrator,
        ${raritySql} as rarity,
        candidates.card_type,
        urls.canonical_path,
        candidates.imported_at as projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        ${availabilityColumns('price_summary', 'cardtrader')}
      from public.marketplace_search_candidates candidates
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = candidates.ct_id
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = candidates.card_id
        or tcg_metadata.blueprint_id = candidates.ct_id
      ${cardTraderAvailabilityJoin('candidates', cheapestCacheRelation)}
      left join (
        select name, min(symbol_image_url) as symbol_image_url
        from public.pokoin_pokemon_expansions
        group by name
      ) expansions
        on expansions.name = candidates.set_name
      left join public.marketplace_blueprint_artists artist
        on artist.card_id = candidates.card_id
      left join public.marketplace_card_urls urls
        on urls.card_id = candidates.card_id
        and urls.language = 'en'
      where candidates.card_id = $1::bigint
      limit 1
    `,
    [normalizedCardId],
  );
  return result.rows;
}

async function rowsForVersions({
  dbQuery = marketplaceQuery,
  query,
  expansionName,
  cardId,
  cardSlug,
  sameAsCardId,
  limit,
  productType,
  productCategory,
  searchLanguage,
}) {
  const route = resolveCardRoute({ cardId, cardSlug });
  const values = [];
  const expansionNumberSql = projectedExpansionNumberSql();
  const expansionNumberIntSql = projectedExpansionNumberIntSql(expansionNumberSql);
  const raritySql = projectedRaritySql({
    rarityColumn: 'candidates.rarity',
    collectorNumberSql: expansionNumberSql,
  });
  let where =
    'where coalesce(versions.preview_image_url, versions.cdn_image_url, versions.image_url) is not null';

  const normalizedCardId = Number(route.cardId);
  if (Number.isSafeInteger(normalizedCardId) && normalizedCardId > 0) {
    values.push(normalizedCardId);
    where += ` and versions.card_id = coalesce((
      select resolved.card_id
      from (
        select c.card_id
        from public.marketplace_search_candidates c
        where c.card_id = $${values.length}::bigint
        union all
        select c.card_id
        from public.marketplace_search_candidates c
        where c.ct_id = $${values.length}::bigint
      ) resolved
      limit 1
    ), $${values.length}::bigint)`;
  }
  where += slugMatchClause(route.cardSlug, values, {
    collectorNumberSql: expansionNumberSql,
    ignoreLeadingClassifier: true,
  });

  const normalizedSameAsCardId = Number(sameAsCardId);
  if (Number.isSafeInteger(normalizedSameAsCardId) && normalizedSameAsCardId > 0) {
    values.push(normalizedSameAsCardId);
    where += ` and exists (
      select 1
      from public.marketplace_card_versions target
      where target.card_id = $${values.length}
        and target.name = versions.name
        and target.expansion_name = versions.expansion_name
    )`;
  }

  const normalizedExpansion = cleanText(expansionName);
  if (normalizedExpansion) {
    values.push(normalizedExpansion);
    where += ` and versions.expansion_name = $${values.length}`;
  }

  const normalizedProductType = cleanText(productType, 60);
  const normalizedProductCategory = cleanProductCategory(productCategory);
  const gradedOnly = normalizedProductCategory === 'graded';
  if (normalizedProductType) {
    values.push(normalizedProductType);
    where += ` and versions.product_type = $${values.length}`;
  }

  where += searchClause(query, normalizedProductType, searchLanguage, values);
  if (gradedOnly) {
    where += ' and coalesce(graded_listings.active_listing_count, 0) > 0';
  }
  values.push(cleanLimit(limit));
  const cheapestCacheRelation = gradedOnly
    ? null
    : await cheapestHomepageCacheRelationName(dbQuery);
  const availabilitySql = gradedOnly
    ? gradedAvailabilityColumns('graded_listings')
    : availabilityColumns('price_summary', 'cardtrader');
  const availabilityJoinSql = gradedOnly
    ? gradedListingSummaryJoin('versions')
    : cardTraderAvailabilityJoin('versions', cheapestCacheRelation);

  const result = await dbQuery(
    `
      select
        versions.card_id,
        versions.name,
        versions.expansion_name,
        ${expansionNumberSql} as expansion_number,
        ${expansionNumberIntSql} as expansion_number_int,
        versions.product_variant,
        versions.blueprint_id,
        versions.image_url,
        versions.cdn_image_url,
        versions.preview_image_url,
        versions.homepage_image_url,
        versions.product_type,
        versions.trainer_name,
        versions.card_palette,
        versions.emoji,
        artist.artist,
        artist.illustrator,
        ${raritySql} as rarity,
        candidates.card_type,
        urls.canonical_path,
        versions.projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        ${availabilitySql}
      from public.marketplace_card_versions versions
      left join public.marketplace_search_candidates candidates
        on candidates.card_id = versions.card_id
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = versions.ct_id
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = versions.card_id
        or tcg_metadata.blueprint_id = versions.ct_id
      ${availabilityJoinSql}
      left join lateral (
        select collector_number
        from public.marketplace_cm_verified_links link
        where link.blueprint_id = versions.ct_id
          and nullif(link.collector_number, '') is not null
        order by
          case link.confidence when 'verified' then 0 when 'manual' then 1 else 2 end,
          link.verified_at desc nulls last,
          link.updated_at desc nulls last
        limit 1
      ) verified_links on true
      left join lateral (
        select collector_number
        from public.marketplace_cm_product_parsing parsing
        where parsing.blueprint_id = versions.ct_id
          and nullif(parsing.collector_number, '') is not null
        order by parsing.verified_at desc nulls last, parsing.updated_at desc nulls last
        limit 1
      ) product_parsing on true
      left join (
        select name, min(symbol_image_url) as symbol_image_url
        from public.pokoin_pokemon_expansions
        group by name
      ) expansions
        on expansions.name = versions.expansion_name
      left join public.marketplace_blueprint_artists artist
        on artist.card_id = versions.card_id
      left join public.marketplace_card_urls urls
        on urls.card_id = versions.card_id
        and urls.language = 'en'
      ${where}
      order by
        versions.expansion_name asc,
        ${normalCollectorSql(expansionNumberSql)} asc,
        ${expansionNumberIntSql} asc nulls last,
        ${normalizedCollectorNumberSql(expansionNumberSql)} asc,
        versions.blueprint_id asc nulls last,
        versions.card_id asc
      limit $${values.length}
    `,
    values,
  );
  if (
    result.rows.length > 0 ||
    query ||
    expansionName ||
    sameAsCardId ||
    normalizedProductType ||
    normalizedProductCategory
  ) {
    return result.rows.map(withCardEmojiFields);
  }

  const fallbackRows = await candidateRowsForCardId(route.cardId, dbQuery);
  if (!route.cardSlug) {
    return fallbackRows.map(withCardEmojiFields);
  }
  return fallbackRows.filter((row) => {
    const canonicalPath = canonicalPathForRow(row);
    const canonicalSlug = canonicalPath
      ? canonicalPath.split('/').filter(Boolean).slice(4).join('-')
      : canonicalSlugForRow(row);
    return canonicalSlugMatches(canonicalSlug, route.cardSlug);
  }).map(withCardEmojiFields);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    const route = resolveCardRoute({
      cardId: url.searchParams.get('cardId'),
      cardSlug: url.searchParams.get('cardSlug') || url.searchParams.get('slug'),
      doubledCardId: url.searchParams.get('doubledCardId') || url.searchParams.get('urlCardId'),
    });
    const rows = await rowsForVersions({
      dbQuery: marketplaceQuery,
      query: url.searchParams.get('query'),
      expansionName: url.searchParams.get('expansionName'),
      cardId: route.cardId,
      cardSlug: route.cardSlug,
      sameAsCardId: url.searchParams.get('sameAsCardId'),
      limit: url.searchParams.get('limit'),
      productType: url.searchParams.get('productType'),
      productCategory: url.searchParams.get('productCategory') || url.searchParams.get('category'),
      searchLanguage: url.searchParams.get('search_language') ||
        url.searchParams.get('lang') ||
        url.searchParams.get('language'),
    });
    recordVersionImages(rows, {
      cardId: route.cardId,
      route: url.pathname + url.search,
    });
    res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=120');
    return res.status(200).json(rows);
  } catch (error) {
    console.error('marketplace-card-versions failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace card versions failed.',
    });
  }
};

module.exports.rowsForVersions = rowsForVersions;
module.exports.cardDetailSlugParts = cardDetailSlugParts;
module.exports.collectorNumberTokenVariants = collectorNumberTokenVariants;
module.exports.cardIdFromDoubledId = cardIdFromDoubledId;
module.exports.pokoinOurId = pokoinOurId;
module.exports.projectedExpansionNumberSql = projectedExpansionNumberSql;
module.exports.projectedExpansionNumberIntSql = projectedExpansionNumberIntSql;
module.exports.projectedRaritySql = projectedRaritySql;
module.exports.resolveCardRoute = resolveCardRoute;
module.exports.slugMatchClause = slugMatchClause;
module.exports.canonicalSlugForRow = canonicalSlugForRow;
module.exports.canonicalPathForRow = canonicalPathForRow;
module.exports.canonicalSlugMatches = canonicalSlugMatches;
module.exports.candidateRowsForCardId = candidateRowsForCardId;
module.exports.activeNativeListingPredicate = activeNativeListingPredicate;
module.exports.gradedAvailabilityColumns = gradedAvailabilityColumns;
module.exports.gradedListingSummaryJoin = gradedListingSummaryJoin;
