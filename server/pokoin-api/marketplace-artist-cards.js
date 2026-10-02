const { marketplaceQuery } = require('./_marketplace_db');
const {
  applyArtistDisplayNameToRow,
  displayNameForArtist,
  lookupAliasesForArtistName,
  normalizeArtistLookupName,
  normalizeArtistSlug,
  slugAliasesForArtistSlug,
} = require('./_artist_display');
const { withCardEmojiFields } = require('./_marketplace_card_emoji');
const { projectedRaritySql } = require('./_marketplace_card_rarity');
const { overlayCheapestOnRows } = require('./_marketplace_react_sql');
const { readArtistSummary } = require('./_artist_summary');

function cleanLimit(value, fallback = 240) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 5000);
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function slugSql(column) {
  return `trim(both '-' from regexp_replace(lower(coalesce(${column}, '')), '[^a-z0-9]+', '-', 'g'))`;
}

function normalizedCollectorNumberSql(column) {
  return `coalesce(
    substring(${column} from '([A-Za-z]*[0-9]+[A-Za-z]?\\s*/\\s*[0-9]+)'),
    substring(${column} from '([A-Za-z]{1,4}\\s*[0-9]+)'),
    ${column}
  )`;
}

function sameOriginArtistProfileImageUrl(value) {
  const clean = cleanText(value, 1000);
  if (!clean) return '';
  try {
    const url = new URL(clean);
    if (
      url.hostname === 'cdn.pokoin.com' &&
      url.pathname.startsWith('/artist-profiles/')
    ) {
      return `https://pokoin.com/card-images${url.pathname}`;
    }
  } catch {
    return clean;
  }
  return clean;
}

function generatedProfileImageVersionedUrl(value, generatedProfileImage = {}) {
  const imageUrl = sameOriginArtistProfileImageUrl(value);
  if (!imageUrl || generatedProfileImage.source !== 'card_art_fallback') {
    return imageUrl;
  }
  const version = cleanText(generatedProfileImage.generatedAt, 120);
  if (!version) {
    return imageUrl;
  }
  try {
    const url = new URL(imageUrl);
    url.searchParams.set('v', version);
    return url.toString();
  } catch {
    const separator = imageUrl.includes('?') ? '&' : '?';
    return `${imageUrl}${separator}v=${encodeURIComponent(version)}`;
  }
}

function projectedExpansionNumberSql() {
  const imageSource = `coalesce(
    versions.cdn_image_url,
    versions.image_url,
    versions.homepage_image_url,
    versions.preview_image_url,
    ''
  )`;
  const imageCollectorNumber = `replace(
    substring(${imageSource} from '([0-9]{1,4}[A-Za-z]?[-/][0-9]{1,4})'),
    '-',
    '/'
  )`;
  return `coalesce(
    nullif(versions.expansion_number, ''),
    nullif(${imageCollectorNumber}, ''),
    versions.expansion_number
  )`;
}

function projectedExpansionNumberIntSql(expansionNumberSql = projectedExpansionNumberSql()) {
  return `coalesce(
    versions.expansion_number_int,
    nullif(substring(${expansionNumberSql} from '([0-9]+)'), '')::integer
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

/** Illustrators index cover: Pikachu, then a gen 1 starter, then Eevee, else listed PKN. */
function artistCoverTier(name) {
  const key = String(name || '').trim().toLowerCase();
  if (/^pikachu(\s|$)/.test(key)) return 1;
  if (/^(bulbasaur|charmander|squirtle)(\s|$)/.test(key)) return 2;
  if (/^eevee(\s|$)/.test(key)) return 3;
  return 4;
}

function leftoverArtistImage(row = {}) {
  for (const value of [row.cdn_image_url, row.image_url, row.homepage_image_url, row.imageUrl]) {
    const text = String(value || '').trim();
    if (!text || /\/previews\//i.test(text) || /\/preview_/i.test(text)) continue;
    return text;
  }
  return '';
}

function leftoverImageSql() {
  return `coalesce(
    nullif(versions.cdn_image_url, ''),
    nullif(versions.image_url, ''),
    nullif(versions.homepage_image_url, '')
  )`;
}

function coverTierSql() {
  return `case
    when lower(versions.name) ~ '^pikachu([[:space:]]|$)' then 1
    when lower(versions.name) ~ '^(bulbasaur|charmander|squirtle)([[:space:]]|$)' then 2
    when lower(versions.name) ~ '^eevee([[:space:]]|$)' then 3
    else 4
  end`;
}

function pickArtistCover(cards) {
  const ranked = (Array.isArray(cards) ? cards : [])
    .map((row) => ({
      row,
      tier: artistCoverTier(row?.name),
      price: Number(row?.lowest_price_pkn || row?.price || 0) || 0,
      imageUrl: leftoverArtistImage(row),
    }))
    .filter((entry) => entry.imageUrl)
    .sort((a, b) => a.tier - b.tier || b.price - a.price);
  return ranked[0]?.row || null;
}

function artistProfileFromRow(row) {
  const sourceAttribution =
    row.profile_source_attribution && typeof row.profile_source_attribution === 'object'
      ? row.profile_source_attribution
      : {};
  const generatedProfileImage =
    sourceAttribution.generatedProfileImage && typeof sourceAttribution.generatedProfileImage === 'object'
      ? sourceAttribution.generatedProfileImage
      : {};
  const imageUrl = generatedProfileImageVersionedUrl(
    row.profile_image_cdn_url || row.profile_image_url || '',
    generatedProfileImage,
  );
  return {
    displayName: displayNameForArtist({
      normalizedArtist: row.normalized_artist,
      profileDisplayName: row.profile_display_name,
      fallbackName: row.artist || row.illustrator,
    }),
    summary: row.profile_summary || '',
    bio: row.profile_bio || '',
    imageUrl,
    sourceImageUrl: row.profile_image_url || '',
    imageObjectKey: row.profile_image_object_key || '',
    pocketmonstersUrl: row.profile_pocketmonsters_url || '',
    pocketmonstersId: row.profile_pocketmonsters_id || '',
    bulbapediaUrl: row.profile_bulbapedia_url || '',
    bulbapediaTitle: row.profile_bulbapedia_title || '',
    sourceName: row.profile_source_name || '',
    sourceUrl: row.profile_source_url || '',
    sourceAttribution,
    generatedProfileImage,
  };
}

async function artistSummaries({ limit, query = marketplaceQuery }) {
  const leftoverImage = leftoverImageSql();
  const result = await query(
    `
      with cheap as (
        select blueprint_id, max(cheapest_price_pkn) as cheapest_price_pkn
        from public.cheapest_homepage_cache_blueprint
        where provider in ('cardtrader', 'pokoin_native')
          and cheapest_price_pkn is not null
          and cheapest_price_pkn > 0
          and coalesce(eligible_listing_count, 0) > 0
        group by blueprint_id
      ),
      artist_cards as (
        select
          artist.artist,
          artist.illustrator,
          artist.normalized_artist,
          ${slugSql('artist.normalized_artist')} as artist_slug,
          artist.artist_card_count,
          versions.blueprint_id,
          versions.ct_id,
          versions.name,
          versions.projected_at,
          ${leftoverImage} as image_url,
          shades.shade as art_shade,
          ${coverTierSql()} as cover_tier,
          cheap.cheapest_price_pkn,
          count(*) over (partition by artist.normalized_artist)::integer as visible_card_count
        from public.marketplace_blueprint_artists artist
        join public.marketplace_card_versions versions
          on versions.blueprint_id = artist.blueprint_id
        left join public.marketplace_leftover_art_shades shades
          on shades.ct_id = versions.ct_id
        left join cheap
          on cheap.blueprint_id = versions.blueprint_id
        where versions.product_type = 'card'
          and ${leftoverImage} is not null
          and ${leftoverImage} !~* '/previews/|/preview_'
      ),
      picked as (
        select distinct on (artist_cards.normalized_artist)
          artist_cards.artist,
          artist_cards.illustrator,
          artist_cards.normalized_artist,
          artist_cards.artist_slug,
          greatest(
            coalesce(artist_cards.artist_card_count, 0),
            coalesce(artist_cards.visible_card_count, 0)
          )::integer as artist_card_count,
          artist_cards.visible_card_count,
          profiles.display_name as profile_display_name,
          coalesce(nullif(profiles.profile_image_cdn_url, ''), profiles.profile_image_url) as profile_image_url,
          artist_cards.image_url,
          artist_cards.name as cover_name,
          artist_cards.art_shade
        from artist_cards
        left join public.marketplace_artist_profiles profiles
          on profiles.normalized_artist = artist_cards.normalized_artist
        order by
          artist_cards.normalized_artist asc,
          artist_cards.cover_tier asc,
          artist_cards.cheapest_price_pkn desc nulls last,
          artist_cards.projected_at desc nulls last,
          artist_cards.blueprint_id asc
      )
      select *
      from picked
      order by artist_card_count desc, artist asc, artist_slug asc
      limit $1
    `,
    [cleanLimit(limit, 1000)],
  );

  return result.rows
    .map((row) => {
      const displayName = displayNameForArtist({
        normalizedArtist: row.normalized_artist,
        profileDisplayName: row.profile_display_name,
        fallbackName: row.artist || row.illustrator,
      });
      return {
      name: displayName || row.artist || row.illustrator || '',
      illustrator: displayName || row.illustrator || row.artist || '',
      normalizedArtist: row.normalized_artist || '',
      slug: row.artist_slug || '',
      cardCount: Number(row.artist_card_count || row.visible_card_count || 0),
      imageUrl: leftoverArtistImage({ image_url: row.image_url }),
      coverName: row.cover_name || '',
      artShade: row.art_shade || '',
      profileImageUrl: sameOriginArtistProfileImageUrl(row.profile_image_url || ''),
      };
    })
    .filter((row) => row.name && row.slug)
    .sort((a, b) => b.cardCount - a.cardCount || a.name.localeCompare(b.name));
}

/** One-row artist + profile lookup so tiles mode can drop the per-row
 * identity columns (15 constant fields repeated on every card row). */
async function artistIdentityRow({ normalizedSlugs, normalizedArtists, query = marketplaceQuery }) {
  const values = [];
  let where;
  if (normalizedSlugs.length > 0) {
    values.push(normalizedSlugs);
    where = `${slugSql('artist.normalized_artist')} = any($${values.length}::text[])`;
  } else if (normalizedArtists.length > 0) {
    values.push(normalizedArtists);
    where = `lower(artist.normalized_artist) = any($${values.length}::text[])`;
  } else {
    return null;
  }
  const result = await query(
    `
      select
        artist.normalized_artist,
        ${slugSql('artist.normalized_artist')} as artist_slug,
        artist.artist,
        artist.illustrator,
        artist.artist_card_count,
        profiles.display_name as profile_display_name,
        profiles.summary as profile_summary,
        profiles.bio as profile_bio,
        profiles.profile_image_url,
        profiles.profile_image_cdn_url,
        profiles.profile_image_object_key,
        profiles.pocketmonsters_url as profile_pocketmonsters_url,
        profiles.pocketmonsters_id as profile_pocketmonsters_id,
        profiles.bulbapedia_url as profile_bulbapedia_url,
        profiles.bulbapedia_title as profile_bulbapedia_title,
        profiles.source_name as profile_source_name,
        profiles.source_url as profile_source_url,
        profiles.source_attribution as profile_source_attribution
      from public.marketplace_blueprint_artists artist
      left join public.marketplace_artist_profiles profiles
        on profiles.normalized_artist = artist.normalized_artist
      where ${where}
      order by artist.artist_card_count desc nulls last
      limit 1
    `,
    values,
  );
  return result.rows[0] || null;
}

async function artistCardsForSlug({
  artistSlug,
  artist,
  limit,
  query = marketplaceQuery,
  overlayCheapest = overlayCheapestOnRows,
  tiles = false,
} = {}) {
  const normalizedSlugs = slugAliasesForArtistSlug(artistSlug);
  const normalizedArtists = lookupAliasesForArtistName(artist);
  const values = [];
  let where =
    'where coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url) is not null';

  if (normalizedSlugs.length > 0) {
    values.push(normalizedSlugs);
    where += ` and ${slugSql('artist.normalized_artist')} = any($${values.length}::text[])`;
  } else if (normalizedArtists.length > 0) {
    values.push(normalizedArtists);
    where += ` and lower(artist.normalized_artist) = any($${values.length}::text[])`;
  } else {
    return { artist: null, cards: [] };
  }

  values.push(cleanLimit(limit));
  const limitPlaceholder = `$${values.length}`;
  const expansionNumberSql = projectedExpansionNumberSql();
  const expansionNumberIntSql = projectedExpansionNumberIntSql(expansionNumberSql);
  const raritySql = projectedRaritySql({
    rarityColumn: 'candidates.rarity',
    collectorNumberSql: expansionNumberSql,
  });
  // tiles=1 (SPA artist desk): the artist/profile fields are constant per
  // artist and served once via artistIdentityRow — repeating them on every
  // one of up to 5000 card rows was the bulk of the multi-MB payload.
  const identityColumns = tiles
    ? ''
    : `        artist.artist,
        artist.illustrator,
        artist.normalized_artist,
        artist.artist_card_count,
        count(*) over ()::integer as total_artist_card_count,
        ${slugSql('artist.normalized_artist')} as artist_slug,
        profiles.display_name as profile_display_name,
        profiles.summary as profile_summary,
        profiles.bio as profile_bio,
        profiles.profile_image_url,
        profiles.profile_image_cdn_url,
        profiles.profile_image_object_key,
        profiles.pocketmonsters_url as profile_pocketmonsters_url,
        profiles.pocketmonsters_id as profile_pocketmonsters_id,
        profiles.bulbapedia_url as profile_bulbapedia_url,
        profiles.bulbapedia_title as profile_bulbapedia_title,
        profiles.source_name as profile_source_name,
        profiles.source_url as profile_source_url,
        profiles.source_attribution as profile_source_attribution,
`;
  const profileJoin = tiles
    ? ''
    : `      left join public.marketplace_artist_profiles profiles
        on profiles.normalized_artist = artist.normalized_artist
`;
  const imageColumn = tiles
    ? '        coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url, \'\') as image_url,'
    : `        coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url, '') as image_url,
        coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url, '') as cdn_image_url,
        versions.preview_image_url,
        versions.homepage_image_url,`;
  const result = await query(
    `
      select
        versions.card_id,
        versions.name,
        versions.expansion_name,
        ${expansionNumberSql} as expansion_number,
        ${expansionNumberIntSql} as expansion_number_int,
        versions.product_variant,
        versions.blueprint_id,
${imageColumn}
        versions.product_type,
        versions.trainer_name,
        versions.card_palette,
        versions.emoji,
        shades.shade as art_shade,
        coalesce(nullif(leftover_layouts.layout, ''), nullif(candidates.art_layout, ''), nullif(version_sets.art_layout, '')) as art_layout,
        nullif(candidates.version, '') as version,
        candidates.pokedex_num,
        candidates.expansion_sort,
        candidates.collector_sort,
        candidates.artwork_cluster_sort,
        candidates.pokedex_sort,
        urls.canonical_path,
${identityColumns}        ${raritySql} as rarity,
        candidates.card_type,
        versions.projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        expansions.nationality
      from public.marketplace_card_versions versions
      join public.marketplace_blueprint_artists artist
        on artist.blueprint_id = versions.blueprint_id
      left join public.marketplace_leftover_art_shades shades
        on shades.ct_id = versions.ct_id
${profileJoin}      left join public.marketplace_search_candidates candidates
        on candidates.card_id = versions.card_id
      left join public.marketplace_leftover_art_layouts leftover_layouts
        on leftover_layouts.ct_id = versions.ct_id
      left join public.pokoin_version_sets version_sets
        on version_sets.version = candidates.version
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = versions.ct_id
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = versions.card_id
        or tcg_metadata.blueprint_id = versions.ct_id
      left join public.marketplace_card_urls urls
        on urls.card_id = versions.card_id
        and urls.language = 'en'
      left join (
        select name,
          min(symbol_image_url) as symbol_image_url,
          min(nationality) as nationality
        from public.pokoin_pokemon_expansions
        group by name
      ) expansions
        on expansions.name = versions.expansion_name
      ${where}
      order by
        candidates.pokedex_sort asc nulls last,
        candidates.version asc nulls last,
        candidates.expansion_sort asc nulls last,
        candidates.collector_sort asc nulls last,
        ${normalCollectorSql(expansionNumberSql)} asc,
        versions.card_id asc
      limit ${limitPlaceholder}
    `,
    values,
  );

  const identity = tiles
    ? await artistIdentityRow({ normalizedSlugs, normalizedArtists, query })
    : result.rows[0] || null;
  const first = identity;
  return {
    artist: first
      ? {
          name: displayNameForArtist({
            normalizedArtist: first.normalized_artist,
            profileDisplayName: first.profile_display_name,
            fallbackName: first.artist || first.illustrator,
          }),
          illustrator: displayNameForArtist({
            normalizedArtist: first.normalized_artist,
            profileDisplayName: first.profile_display_name,
            fallbackName: first.illustrator || first.artist,
          }),
          normalizedArtist: first.normalized_artist || '',
          slug: first.artist_slug || normalizedSlugs[0] || '',
          cardCount: Number(first.artist_card_count || first.total_artist_card_count || result.rows.length),
        }
      : null,
    profile: first ? artistProfileFromRow(first) : null,
    cards: await overlayCheapest(
      (tiles ? result.rows : result.rows.map(applyArtistDisplayNameToRow)).map(withCardEmojiFields),
    ),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || 'pokoin.com'}`);
    if (url.searchParams.get('summaries') === '1') {
      const limit = url.searchParams.get('limit');
      const projectedRows = await readArtistSummary(marketplaceQuery, cleanLimit(limit, 240));
      const artists = projectedRows
        ? projectedRows.map((row) => {
          const displayName = displayNameForArtist({
            normalizedArtist: row.normalized_artist,
            profileDisplayName: row.profile_display_name,
            fallbackName: row.artist || row.illustrator,
          });
          return {
            name: displayName || row.artist || row.illustrator || '',
            illustrator: displayName || row.illustrator || row.artist || '',
            normalizedArtist: row.normalized_artist || '',
            slug: row.artist_slug || '',
            cardCount: Number(row.artist_card_count || row.visible_card_count || 0),
            imageUrl: leftoverArtistImage({ image_url: row.image_url }),
            coverName: row.cover_name || '',
            artShade: row.art_shade || '',
            profileImageUrl: sameOriginArtistProfileImageUrl(row.profile_image_url || ''),
          };
        }).filter((row) => row.name && row.slug)
        : await artistSummaries({ limit });
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=3600');
      return res.status(200).json({ artists });
    }
    const payload = await artistCardsForSlug({
      artistSlug: url.searchParams.get('artistSlug') || url.searchParams.get('slug'),
      artist: url.searchParams.get('artist'),
      limit: url.searchParams.get('limit'),
      tiles: url.searchParams.get('tiles') === '1',
    });
    res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=300');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('marketplace-artist-cards failed', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Marketplace artist cards failed.',
    });
  }
};

module.exports.artistCardsForSlug = artistCardsForSlug;
module.exports.artistSummaries = artistSummaries;
module.exports.artistCoverTier = artistCoverTier;
module.exports.artistProfileFromRow = artistProfileFromRow;
module.exports.leftoverArtistImage = leftoverArtistImage;
module.exports.pickArtistCover = pickArtistCover;
module.exports.normalizeArtistSlug = normalizeArtistSlug;
module.exports.normalizeArtistLookupName = normalizeArtistLookupName;
module.exports.lookupAliasesForArtistName = lookupAliasesForArtistName;
module.exports.slugAliasesForArtistSlug = slugAliasesForArtistSlug;
module.exports.projectedRaritySql = projectedRaritySql;
