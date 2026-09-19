const { marketplaceQuery } = require('./_marketplace_db');
const { rowsForSearchTerm } = require('./marketplace-search-candidates');
const { useMeiliSearchForLanguage } = require('./_marketplace_search_engine');
const {
  watchlistAnalyticsJoin,
  watchlistCountColumn,
} = require('./_marketplace_watchlist_analytics');
const {
  cartAnalyticsJoin,
  cartHolderCountColumn,
} = require('./_marketplace_cart_analytics');
const { withCardEmojiFields } = require('./_marketplace_card_emoji');
const { normalizeMarketplaceRow } = require('./_marketplace_row');
const { projectedRaritySql } = require('./_marketplace_card_rarity');
const { recordCardsImages } = require('./_marketplace_image_log');

const CHEAPEST_HOMEPAGE_CACHE_RELATIONS = new Set([
  'public.cheapest_homepage_cache_blueprint',
  'public.cardtrader_blueprint_listing_cache',
]);
let cachedCheapestHomepageCacheRelation = null;

function cleanLimit(value, fallback = 240) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}

function cleanSearchPageLimit(value, fallback = 100) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function cleanOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(offset), 0), 10000);
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
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

function cardTraderEligiblePredicate(alias = 'snapshot') {
  return `(
    coalesce(${alias}.quantity, 0) > 0
    and public.marketplace_price_pkn_from_cardtrader(${alias}.price, ${alias}.price_cents, ${alias}.currency) is not null
    and (
      lower(coalesce(${alias}.raw_metadata->'user'->>'can_sell_via_hub', ${alias}.raw_metadata->>'can_sell_via_hub', '')) in ('true', '1', 'yes', 'y')
      or lower(coalesce(${alias}.raw_metadata->'user'->>'can_sell_sealed_with_ct_zero', ${alias}.raw_metadata->>'can_sell_sealed_with_ct_zero', '')) in ('true', '1', 'yes', 'y')
    )
  )`;
}

function availabilityColumns(prefix = 'price_summary', cardTraderPrefix = 'cardtrader') {
  return `
    coalesce(${cardTraderPrefix}.eligible_quantity, ${cardTraderPrefix}.eligible_listing_count, 0) as listed_quantity,
    ${cardTraderPrefix}.cheapest_price_pkn as lowest_price_pkn,
    case
      when ${cardTraderPrefix}.cheapest_price_pkn is not null
        then case
          when ${cardTraderPrefix}.provider = 'pokoin_native' then 'pokoin_native_homepage_cache'
          else 'cheapest_homepage_cache_blueprint'
        end
      else null
    end as homepage_cheapest_source,
    ${cardTraderPrefix}.provider as homepage_cheapest_provider,
    ${cardTraderPrefix}.sample_listing_id as homepage_cheapest_listing_id,
    case
      when ${cardTraderPrefix}.provider = 'cardtrader'
        then coalesce(${cardTraderPrefix}.eligible_listing_count, 0)
      else 0
    end as cardtrader_eligible_listing_count,
    (${cardTraderPrefix}.provider = 'cardtrader' and coalesce(${cardTraderPrefix}.eligible_listing_count, 0) > 0) as has_cardtrader_listing,
    case
      when ${cardTraderPrefix}.provider = 'cardtrader'
        then coalesce(${cardTraderPrefix}.eligible_quantity, 0)
      else 0
    end as cardtrader_listed_quantity,
    case
      when ${cardTraderPrefix}.provider = 'cardtrader' then ${cardTraderPrefix}.cheapest_price_pkn
      else null
    end as cardtrader_lowest_price_pkn,
    (${cardTraderPrefix}.provider = 'cardtrader' and coalesce(${cardTraderPrefix}.eligible_listing_count, 0) > 0) as cardtrader_available
  `;
}

function cleanCheapestHomepageCacheRelation(value) {
  const relation = String(value || '').trim();
  return CHEAPEST_HOMEPAGE_CACHE_RELATIONS.has(relation)
    ? relation
    : 'public.cheapest_homepage_cache_blueprint';
}

function resetCheapestHomepageCacheRelationForTest() {
  cachedCheapestHomepageCacheRelation = null;
}

async function cheapestHomepageCacheRelationName(query = marketplaceQuery) {
  if (cachedCheapestHomepageCacheRelation) {
    return cachedCheapestHomepageCacheRelation;
  }
  const result = await query(`
    select case
      when to_regclass('public.cheapest_homepage_cache_blueprint') is not null
        then 'public.cheapest_homepage_cache_blueprint'
      when to_regclass('public.cardtrader_blueprint_listing_cache') is not null
        then 'public.cardtrader_blueprint_listing_cache'
      else 'public.cheapest_homepage_cache_blueprint'
    end as relation
  `);
  cachedCheapestHomepageCacheRelation = cleanCheapestHomepageCacheRelation(
    result.rows[0]?.relation,
  );
  return cachedCheapestHomepageCacheRelation;
}

function cardTraderAvailabilityJoin(
  candidateAlias = 'c',
  relation = 'public.cheapest_homepage_cache_blueprint',
) {
  const cacheRelation = cleanCheapestHomepageCacheRelation(relation);
  const cardIdColumn = `${candidateAlias}.card_id`;
  const ctIdColumn = `${candidateAlias}.ct_id`;
  return `
    left join lateral (
      select cardtrader_cache.*
      from ${cacheRelation} cardtrader_cache
      where cardtrader_cache.provider in ('cardtrader', 'pokoin_native')
        and cardtrader_cache.eligible_listing_count > 0
        and cardtrader_cache.cheapest_price_pkn is not null
        and (
          cardtrader_cache.blueprint_id = ${ctIdColumn}
          or cardtrader_cache.pokoin_card_id = ${cardIdColumn}::text
        )
      order by
        case when cardtrader_cache.blueprint_id = ${ctIdColumn} then 0 else 1 end,
        cardtrader_cache.cheapest_price_pkn asc,
        case when cardtrader_cache.provider = 'pokoin_native' then 0 else 1 end,
        cardtrader_cache.eligible_listing_count desc,
        cardtrader_cache.blueprint_id asc,
        cardtrader_cache.provider asc
      limit 1
    ) cardtrader on true
  `;
}

function hasStructuredNameNumberQuery(query) {
  const terms = searchTerms(query);
  return terms.some((term) => /^[0-9]+$/.test(term)) &&
    terms.some((term) => !/^[0-9]+$/.test(term));
}

function productTypeClause(productType, productSearchOnly, values) {
  const normalized = cleanText(productType, 60);
  if (normalized) {
    // Exact subtype filter (productType=card singles, productType=jumbo on the
    // Products page). Search tabs never split card vs jumbo: jumbo is a
    // subtype inside Product.
    values.push(normalized);
    return ` and marketplace_search_candidates.product_type = $${values.length}`;
  }
  if (productSearchOnly) {
    // Product search universe: sealed products plus the jumbo subtype (083).
    // Jumbos stay item_kind 'single', so item_kind alone would drop them.
    return " and (marketplace_search_candidates.item_kind = 'product'"
      + " or marketplace_search_candidates.product_type = 'jumbo')";
  }
  return '';
}

function searchClause(query, productSearchOnly, searchLanguage, values) {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return '';
  }
  const fields = productSearchOnly
    ? [
        'marketplace_search_candidates.name',
        'marketplace_search_candidates.set_name',
        'marketplace_search_candidates.product_variant',
        'marketplace_search_candidates.trainer_name',
      ]
    : [
        'marketplace_search_candidates.name',
        'marketplace_search_candidates.set_name',
        'marketplace_search_candidates.trainer_name',
        'marketplace_search_candidates.card_type',
        'marketplace_search_candidates.rarity',
        'marketplace_search_candidates.card_number',
        'marketplace_search_candidates.product_variant',
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
          and translations.name = marketplace_search_candidates.name
          and translations.localized_name ilike ${placeholder}
      ))`;
  });
  return ` and ${clauses.join(' and ')}`;
}

async function fallbackRowsForStructuredCards({ query, limit, searchLanguage }) {
  if (!hasStructuredNameNumberQuery(query)) return [];
  const {
    rankAutocompleteRows,
    rowsForAutocompleteSearchTermWithQuery,
  } = require('./marketplace-autocomplete');
  const cleanResultLimit = cleanLimit(limit);
  const raritySql = projectedRaritySql({
    rarityColumn: 'c.rarity',
    collectorNumberSql: "coalesce(nullif(c.card_number, ''), ranked.card_number)",
    blueprintAlias: 'blueprints',
  });
  const candidateRows = await rowsForAutocompleteSearchTermWithQuery(
    query,
    Math.min(Math.max(cleanResultLimit * 8, 100), 500),
    searchLanguage,
    null,
    null,
  );
  const rankedRows = rankAutocompleteRows(candidateRows, query, cleanResultLimit);
  const ids = rankedRows
    .map((row) => Number(row.card_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return [];
  const cheapestCacheRelation = await cheapestHomepageCacheRelationName();
  const result = await marketplaceQuery(
    `
      with settings as (
        select set_config('app.pkn_usdt_price', $2::text, true)
      )
      select
        c.card_id, c.name, c.product_variant as version, c.image_url, c.cdn_image_url,
        c.preview_image_url, c.set_name, ${raritySql} as rarity, c.card_type,
        coalesce(nullif(c.card_number, ''), ranked.card_number) as card_number,
        c.product_variant, false as is_holo, false as is_foil, c.item_kind, c.product_type,
        c.trainer_name, c.artist, c.illustrator,
        c.card_palette, c.emoji, c.imported_at,
        ${watchlistCountColumn('watchlist_analytics')},
        ${cartHolderCountColumn('cart_analytics')},
        ${availabilityColumns('price_summary', 'cardtrader')},
        ranked.ordinality
      from settings,
        unnest($1::bigint[], $3::text[]) with ordinality as ranked(card_id, card_number, ordinality)
      join public.marketplace_search_candidates c on c.card_id = ranked.card_id
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = coalesce(c.ct_id, c.card_id)
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = c.card_id
        or tcg_metadata.blueprint_id = coalesce(c.ct_id, c.card_id)
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = coalesce(c.ct_id, c.card_id)
      ${cardTraderAvailabilityJoin('c', cheapestCacheRelation)}
      ${watchlistAnalyticsJoin('c', 'watchlist_analytics')}
      ${cartAnalyticsJoin('c', 'cart_analytics')}
      order by ranked.ordinality
    `,
    [ids, String(process.env.PKN_CHECKOUT_USDT_PRICE || 0.005), rankedRows.map((row) => String(row.card_number || ''))],
  );
  return result.rows.map(({ ordinality, ...row }) => withCardEmojiFields(normalizeMarketplaceRow(row)));
}

async function rowsForCards({
  query,
  limit,
  offset = 0,
  productType,
  productSearchOnly,
  searchLanguage,
  printLanguage = 'all',
  lightHydrate = false,
  withTotal = false,
}) {
  const nameQuery = cleanText(query);
  const typedProduct = cleanText(productType, 60);
  const language = cleanLanguage(searchLanguage);
  const { cleanPrintLanguage, effectivePrintBucket, printLangMatchesBucket } = require('./_print_bucket');
  const print = cleanPrintLanguage(printLanguage);
  // Singles tab sends productType=card. That used to skip Meili and run
  // ILIKE AND-of-tokens, so "View all 51" for Shuppet Lv.17 painted 2 rows.
  if (
    nameQuery &&
    !productSearchOnly &&
    // The jumbo subtype browse (Products page, productType=jumbo) bypasses the
    // Meili window: jumbos do not rank in the top text hits for a name, and
    // that page must list every one of them.
    typedProduct !== 'jumbo' &&
    useMeiliSearchForLanguage(language)
  ) {
    const loaded = await rowsForSearchTerm(
      nameQuery,
      cleanSearchPageLimit(limit),
      cleanOffset(offset),
      language,
      null,
      null,
      {
        lightHydrate: lightHydrate === true,
        printLanguage: print,
        withTotal: withTotal === true,
      },
    );
    const payloadRows = withTotal === true && loaded && !Array.isArray(loaded)
      ? loaded.rows
      : loaded;
    const meiliTotal = withTotal === true && loaded && !Array.isArray(loaded)
      ? loaded.total
      : null;
    let next = payloadRows;
    if (typedProduct) {
      next = next.filter((row) => String(row.product_type || '') === typedProduct);
    }
    if (print !== 'all') {
      next = next.filter((row) => printLangMatchesBucket(print, effectivePrintBucket(row)));
    }
    if (withTotal === true) {
      return { rows: next, total: Number.isFinite(meiliTotal) ? meiliTotal : null };
    }
    return next;
  }
  const values = [];
  const raritySql = projectedRaritySql({
    rarityColumn: 'marketplace_search_candidates.rarity',
    collectorNumberSql: 'marketplace_search_candidates.card_number',
    blueprintAlias: 'blueprints',
  });
  let where = 'where coalesce(marketplace_search_candidates.preview_image_url, marketplace_search_candidates.cdn_image_url, marketplace_search_candidates.image_url) is not null';
  where += productTypeClause(productType, productSearchOnly, values);
  where += searchClause(query, productSearchOnly, searchLanguage, values);
  values.push(cleanLimit(limit));
  values.push(String(process.env.PKN_CHECKOUT_USDT_PRICE || 0.005));
  const limitIndex = values.length - 1;
  const cheapestCacheRelation = await cheapestHomepageCacheRelationName();

  const result = await marketplaceQuery(
    `
      with settings as (
        select set_config('app.pkn_usdt_price', $${values.length}::text, true)
      )
      select
        ${withTotal === true ? 'count(*) over () as total_count,' : ''}
        marketplace_search_candidates.card_id,
        marketplace_search_candidates.name,
        marketplace_search_candidates.product_variant as version,
        marketplace_search_candidates.image_url,
        marketplace_search_candidates.cdn_image_url,
        marketplace_search_candidates.preview_image_url,
        marketplace_search_candidates.set_name,
        (
          select e.nationality
          from public.pokoin_pokemon_expansions e
          where e.name = marketplace_search_candidates.set_name
             or e.normalized_name = public.marketplace_search_normalize(marketplace_search_candidates.set_name)
          order by case when e.name = marketplace_search_candidates.set_name then 0 else 1 end
          limit 1
        ) as nationality,
        ${raritySql} as rarity,
        marketplace_search_candidates.card_type,
        marketplace_search_candidates.card_number,
        marketplace_search_candidates.product_variant,
        false as is_holo,
        false as is_foil,
        marketplace_search_candidates.item_kind,
        marketplace_search_candidates.product_type,
        marketplace_search_candidates.trainer_name,
        marketplace_search_candidates.artist,
        marketplace_search_candidates.illustrator,
        marketplace_search_candidates.card_palette,
        marketplace_search_candidates.emoji,
        marketplace_search_candidates.imported_at,
        ${watchlistCountColumn('watchlist_analytics')},
        ${cartHolderCountColumn('cart_analytics')},
        ${availabilityColumns('price_summary', 'cardtrader')}
      from settings,
        public.marketplace_search_candidates
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = coalesce(marketplace_search_candidates.ct_id, marketplace_search_candidates.card_id)
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = marketplace_search_candidates.card_id
        or tcg_metadata.blueprint_id = coalesce(marketplace_search_candidates.ct_id, marketplace_search_candidates.card_id)
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = coalesce(marketplace_search_candidates.ct_id, marketplace_search_candidates.card_id)
      ${cardTraderAvailabilityJoin('marketplace_search_candidates', cheapestCacheRelation)}
      ${watchlistAnalyticsJoin('marketplace_search_candidates', 'watchlist_analytics')}
      ${cartAnalyticsJoin('marketplace_search_candidates', 'cart_analytics')}
      ${where}
      order by marketplace_search_candidates.search_weight desc,
        marketplace_search_candidates.imported_at desc nulls last,
        marketplace_search_candidates.card_id desc
      limit $${limitIndex}
    `,
    values,
  );
  if (
    result.rows.length > 0 ||
    cleanText(productType, 60) ||
    productSearchOnly
  ) {
    const firstRowCount = result.rows.length ? Number(result.rows[0].total_count) : null;
    let rows = result.rows.map(({ total_count, ...row }) => withCardEmojiFields(normalizeMarketplaceRow(row)));
    if (print !== 'all') {
      rows = rows.filter((row) => printLangMatchesBucket(print, effectivePrintBucket(row)));
    }
    if (withTotal === true) {
      // Same-WHERE exact count: the window function evaluates before LIMIT,
      // so total answers the identical predicate as the rows — no second query.
      return { rows, total: Number.isFinite(firstRowCount) ? firstRowCount : null };
    }
    return rows;
  }
  const fallback = await fallbackRowsForStructuredCards({ query, limit, searchLanguage });
  const fallbackRows = print === 'all'
    ? fallback
    : fallback.filter((row) => printLangMatchesBucket(print, effectivePrintBucket(row)));
  if (withTotal === true) {
    return { rows: fallbackRows, total: null };
  }
  return fallbackRows;
}

async function productFacetRows({ query, searchLanguage, dbQuery = marketplaceQuery }) {
  const values = [];
  const productTypeSql = `case
    when marketplace_search_candidates.item_kind = 'product'
      then coalesce(nullif(marketplace_search_candidates.product_type, ''), 'sealed_product')
    else 'card'
  end`;
  let where = 'where coalesce(marketplace_search_candidates.preview_image_url, marketplace_search_candidates.cdn_image_url, marketplace_search_candidates.image_url) is not null';
  where += searchClause(query, false, searchLanguage, values);

  const result = await dbQuery(
    `
      with product_facets as (
        select
          ${productTypeSql} as product_type,
          count(*)::integer as count
        from public.marketplace_search_candidates
        ${where}
        group by 1
      )
      select product_type, count
      from product_facets
      order by
        case
          when product_type = 'card' then 0
          when product_type = 'booster_box' then 10
          when product_type = 'booster_pack' then 20
          else 100
        end asc,
        count desc,
        product_type asc
    `,
    values,
  );
  return result.rows.map((row) => ({
    productType: String(row.product_type || ''),
    count: Number(row.count || 0),
  })).filter((row) => row.productType && row.count > 0);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    if (url.searchParams.get('facets') === 'products') {
      const products = await productFacetRows({
        query: url.searchParams.get('query') || url.searchParams.get('q'),
        searchLanguage: url.searchParams.get('search_language') ||
          url.searchParams.get('lang') ||
          url.searchParams.get('language'),
      });
      res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=120');
      return res.status(200).json({ products });
    }
    const rows = await rowsForCards({
      query: url.searchParams.get('query') || url.searchParams.get('q'),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      productType: url.searchParams.get('productType'),
      productSearchOnly: url.searchParams.get('productSearchOnly') === '1',
      searchLanguage: url.searchParams.get('search_language') ||
        url.searchParams.get('lang') ||
        url.searchParams.get('language'),
    });
    const payload = Array.isArray(rows) ? rows.map(normalizeMarketplaceRow) : rows;
    recordCardsImages(payload, {
      query: url.searchParams.get('query') || url.searchParams.get('q') || '',
      route: url.pathname + url.search,
    });
    res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=120');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('marketplace-cards failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace cards failed.',
    });
  }
};

module.exports.rowsForCards = rowsForCards;
module.exports.productFacetRows = productFacetRows;
module.exports.fallbackRowsForStructuredCards = fallbackRowsForStructuredCards;
module.exports.availabilityColumns = availabilityColumns;
module.exports.cardTraderAvailabilityJoin = cardTraderAvailabilityJoin;
module.exports.cardTraderEligiblePredicate = cardTraderEligiblePredicate;
module.exports.cheapestHomepageCacheRelationName = cheapestHomepageCacheRelationName;
module.exports.resetCheapestHomepageCacheRelationForTest = resetCheapestHomepageCacheRelationForTest;
module.exports.hasStructuredNameNumberQuery = hasStructuredNameNumberQuery;
