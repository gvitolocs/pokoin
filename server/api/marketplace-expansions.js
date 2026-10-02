const { marketplaceQuery } = require('./_marketplace_db');
const { withCardEmojiFields } = require('./_marketplace_card_emoji');
const { expansionSlugSql } = require('./_marketplace_react_sql');

function cleanLimit(value, fallback = 1000) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 2000);
}

function cleanText(value, maxLength = 180) {
  return String(value || '').trim().slice(0, maxLength);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function normalizedCollectorNumberSql(column) {
  return `coalesce(
    substring(${column} from '([A-Za-z]*[0-9]+[A-Za-z]?\\s*/\\s*[0-9]+)'),
    substring(${column} from '([A-Za-z]{1,4}\\s*[0-9]+)'),
    ${column}
  )`;
}

function normalCollectorSql(column) {
  const normalized = normalizedCollectorNumberSql(column);
  return `case
    when ${normalized} ~ '^\\s*[0-9]+[A-Za-z]?\\s*(/[0-9]+)?\\s*$'
    then 0
    else 1
  end`;
}

async function rowsForExpansions({ slug, limit, query = marketplaceQuery }) {
  const values = [];
  let where = "where versions.expansion_name is not null and versions.expansion_name <> '' and versions.product_type = 'card'";
  const normalizedSlug = cleanText(slug);
  if (normalizedSlug) {
    values.push(normalizedSlug);
    where += ` and ${expansionSlugSql('versions.expansion_name')} = $${values.length}`;
  }
  values.push(cleanLimit(limit));

  const result = await query(
    `
      with representative_cards as (
        select distinct on (
          versions.expansion_name,
          ${normalizedCollectorNumberSql('versions.expansion_number')}
        )
          versions.expansion_name,
          versions.expansion_number,
          versions.expansion_number_int
        from public.marketplace_card_versions versions
        ${where}
        order by
          versions.expansion_name asc,
          ${normalizedCollectorNumberSql('versions.expansion_number')} asc,
          versions.blueprint_id asc nulls last,
          versions.card_id asc
      )
      select
        representative_cards.expansion_name as name,
        min(expansions.symbol_image_url) as symbol_image_url,
        min(expansions.logo_image_url) as logo_image_url,
        coalesce(
          nullif(min(expansions.catalog_card_count), 0),
          nullif(min(set_counts.catalog_card_count), 0),
          0
        )::integer as card_count,
        min(expansions.nationality) as nationality
      from representative_cards
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = representative_cards.expansion_name
      left join public.marketplace_set_card_counts set_counts
        on set_counts.set_name = representative_cards.expansion_name
      group by representative_cards.expansion_name
      order by representative_cards.expansion_name asc
      limit $${values.length}
    `,
    values,
  );

  return result.rows.map((row) => {
    const name = row.name || '';
    const resolvedSlug = slugify(name);
    return {
      name,
      slug: resolvedSlug,
      symbolImageUrl: row.symbol_image_url || '',
      logoImageUrl: row.logo_image_url || '',
      defaultSymbolUrl: resolvedSlug
        ? `https://cdn.pokoin.com/expansions/symbols/${resolvedSlug}.png`
        : '',
      cardCount: Number(row.card_count || 0),
      nationality: String(row.nationality || '').trim().toLowerCase(),
    };
  });
}

async function snapshotForExpansion({ slug, limit, query = marketplaceQuery }) {
  const expansions = await rowsForExpansions({ slug, limit: 1, query });
  const expansion = expansions[0];
  if (!expansion) {
    return null;
  }
  const result = await query(
    `
      with representative_cards as (
        select distinct on (
          versions.expansion_name,
          ${normalizedCollectorNumberSql('versions.expansion_number')}
        )
          versions.*
        from public.marketplace_card_versions versions
        where versions.expansion_name = $1
          and versions.product_type = 'card'
        order by
          versions.expansion_name asc,
          ${normalizedCollectorNumberSql('versions.expansion_number')} asc,
          versions.blueprint_id asc nulls last,
          versions.card_id asc
      )
      select
        representative_cards.card_id,
        representative_cards.name,
        representative_cards.expansion_name,
        representative_cards.expansion_number,
        representative_cards.expansion_number_int,
        representative_cards.product_variant,
        representative_cards.blueprint_id,
        representative_cards.image_url,
        representative_cards.cdn_image_url,
        representative_cards.preview_image_url,
        representative_cards.product_type,
        representative_cards.trainer_name,
        representative_cards.card_palette,
        representative_cards.emoji,
        urls.canonical_path,
        representative_cards.projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        expansions.logo_image_url as expansion_logo_url
      from representative_cards
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = representative_cards.expansion_name
      left join public.marketplace_card_urls urls
        on urls.card_id = representative_cards.card_id
        and urls.language = 'en'
      order by
        ${normalCollectorSql('representative_cards.expansion_number')} asc,
        representative_cards.expansion_number_int asc nulls last,
        ${normalizedCollectorNumberSql('representative_cards.expansion_number')} asc,
        representative_cards.blueprint_id asc nulls last,
        representative_cards.card_id asc
      limit $2
    `,
    [expansion.name, cleanLimit(limit)],
  );
  return { expansion, cards: result.rows.map(withCardEmojiFields) };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    if (url.searchParams.get('includeCards') === '1') {
      const snapshot = await snapshotForExpansion({
        slug: url.searchParams.get('slug'),
        limit: url.searchParams.get('limit'),
      });
      if (!snapshot) {
        return res.status(404).json({ error: 'Expansion not found.' });
      }
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
      return res.status(200).json(snapshot);
    }
    const expansions = await rowsForExpansions({
      slug: url.searchParams.get('slug'),
      limit: url.searchParams.get('limit'),
    });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return res.status(200).json({ expansions });
  } catch (error) {
    console.error('marketplace-expansions failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace expansions failed.',
    });
  }
};

module.exports.rowsForExpansions = rowsForExpansions;
module.exports.snapshotForExpansion = snapshotForExpansion;
