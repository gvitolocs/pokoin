'use strict';

/**
 * Indexed lookups for React page BFFs. Do not ORDER BY imported_at on the
 * full candidates table (no index; statement timeout). Prefer card_id,
 * set_name equality, or hot_blueprints.blueprint_id = ct_id.
 */
const { marketplaceQuery, isPokemonGame } = require('./_marketplace_db');

const NEWEST_ENGLISH_SET_NAMES = [
  'Mega Evolution',
  'Phantasmal Flames',
  'Black Bolt',
  'White Flare',
  'Destined Rivals',
  'Journey Together',
  'Prismatic Evolutions',
  'Surging Sparks',
  'Stellar Crown',
  'Shrouded Fable',
  'Twilight Masquerade',
  'Temporal Forces',
  'Paldean Fates',
];

const CANDIDATE_COLUMNS_BASE = `
  c.card_id,
  c.ct_id,
  c.name,
  c.image_url,
  c.cdn_image_url,
  c.preview_image_url,
  c.homepage_image_url,
  c.set_name,
  c.rarity,
  c.card_number,
  c.item_kind,
  c.product_type
`;

/** Pokemon candidates have `version`, `emoji` (060) and denormed illustrator.
 * Isolated satellite catalogs (Magic, OP, RB, …) do not: selecting them there
 * fails every card-page lookup with 42703. */
function candidateColumns() {
  if (isPokemonGame()) {
    return `${CANDIDATE_COLUMNS_BASE},
  c.emoji,
  c.version,
  coalesce(c.rarity_kind, '') as rarity_kind,
  coalesce(c.art_layout, '') as art_layout,
  coalesce(c.artist, '') as artist,
  coalesce(c.illustrator, '') as illustrator`;
  }
  return `${CANDIDATE_COLUMNS_BASE},
  ''::text as emoji,
  null::text as version,
  null::text as rarity_kind,
  null::text as art_layout,
  null::text as artist,
  null::text as illustrator`;
}

async function readStoredCatalogCardCount(setName) {
  const name = String(setName || '').trim();
  if (!name) {
    return 0;
  }
  if (isPokemonGame()) {
    const result = await marketplaceQuery(
      `
        select coalesce(
          (
            select catalog_card_count
            from public.marketplace_set_card_counts
            where set_name = $1
          ),
          (
            select catalog_card_count
            from public.pokoin_pokemon_expansions
            where name = $1
          ),
          0
        )::int as catalog_card_count
      `,
      [name],
    );
    return Number(result.rows[0]?.catalog_card_count) || 0;
  }
  const result = await marketplaceQuery(
    `
      select catalog_card_count
      from public.marketplace_set_card_counts
      where set_name = $1
      limit 1
    `,
    [name],
  );
  return Number(result.rows[0]?.catalog_card_count) || 0;
}

/** Match JS slugify: unaccent (Pokémon→Pokemon) then `&` → ` and ` before non-alnum. */
function expansionSlugSql(column) {
  return `trim(both '-' from lower(regexp_replace(replace(public.unaccent(${column}), '&', ' and '), '[^a-zA-Z0-9]+', '-', 'g')))`;
}

async function readExpansionBySlug(slug) {
  const key = String(slug || '').trim().toLowerCase();
  if (!key) {
    return null;
  }
  if (isPokemonGame()) {
    const result = await marketplaceQuery(
      `
        select
          name,
          symbol_image_url,
          logo_image_url,
          catalog_card_count,
          nationality
        from public.pokoin_pokemon_expansions
        where ${expansionSlugSql('name')} = $1
        limit 1
      `,
      [key],
    );
    const row = result.rows[0];
    if (row) {
      const stored = Number(row.catalog_card_count) || 0;
      return {
        name: row.name,
        slug: key,
        symbolImageUrl: row.symbol_image_url || '',
        logoImageUrl: row.logo_image_url || '',
        defaultSymbolUrl: `https://cdn.pokoin.com/expansions/symbols/${key}.png`,
        cardCount: stored || await readStoredCatalogCardCount(row.name),
        nationality: String(row.nationality || '').trim().toLowerCase(),
      };
    }
  }
  // Every satellite DB has pokoin_pokemon_expansions (logo rows are optional).
  // Wordmarks stamped there are the set-guide art; an empty logo stays the letter mark.
  const fallback = await marketplaceQuery(
    isPokemonGame()
      ? `
      select
        c.set_name as name,
        c.slug,
        c.catalog_card_count,
        e.nationality,
        coalesce(e.logo_image_url, '') as logo_image_url,
        coalesce(e.symbol_image_url, '') as symbol_image_url
      from public.marketplace_set_card_counts c
      left join public.pokoin_pokemon_expansions e
        on e.name = c.set_name
      where c.slug = $1
         or ${expansionSlugSql('c.set_name')} = $1
      order by c.catalog_card_count desc
      limit 1
    `
      : `
      select
        c.set_name as name,
        c.slug,
        c.catalog_card_count,
        coalesce(nullif(nullif(trim(e.nationality), ''), 'unknown'), '') as nationality,
        coalesce(logos.logo_image_url, '') as logo_image_url,
        coalesce(logos.symbol_image_url, '') as symbol_image_url
      from public.marketplace_set_card_counts c
      left join public.pokoin_expansions e
        on e.name = c.set_name
      left join public.pokoin_pokemon_expansions logos
        on logos.name = c.set_name
      where c.slug = $1
         or ${expansionSlugSql('c.set_name')} = $1
      order by c.catalog_card_count desc
      limit 1
    `,
    [key],
  );
  const row = fallback.rows[0];
  if (!row) {
    return null;
  }
  return expansionFromSetCount(row, key);
}

function expansionFromSetCount(row, slugFallback = '') {
  const name = String(row?.name || '').trim();
  const slug = String(row?.slug || slugFallback || '')
    .trim()
    .toLowerCase()
    || name
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return {
    name,
    slug,
    symbolImageUrl: String(row?.symbol_image_url || '').trim(),
    logoImageUrl: String(row?.logo_image_url || '').trim(),
    defaultSymbolUrl: '',
    cardCount: Number(row?.catalog_card_count) || 0,
    nationality: String(row?.nationality || '').trim().toLowerCase(),
  };
}

async function readExpansionsFromSetCounts(limit = 500) {
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const result = await marketplaceQuery(
    `
      select
        c.set_name as name,
        c.slug,
        c.catalog_card_count,
        coalesce(logos.logo_image_url, '') as logo_image_url,
        coalesce(logos.symbol_image_url, '') as symbol_image_url
      from public.marketplace_set_card_counts c
      left join public.pokoin_pokemon_expansions logos
        on logos.name = c.set_name
      where c.catalog_card_count > 0
      order by c.catalog_card_count desc, c.set_name
      limit $1
    `,
    [cap],
  );
  return result.rows.map((row) => expansionFromSetCount(row));
}

async function readCandidateByCardId(cardId) {
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  const result = await marketplaceQuery(
    `
      select ${candidateColumns()}
      from public.marketplace_search_candidates c
      where c.card_id = $1::bigint
      limit 1
    `,
    [id],
  );
  return result.rows[0] || null;
}

async function readCandidatesByCardIds(cardIds) {
  const ids = [...new Set((cardIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) {
    return [];
  }
  const result = await marketplaceQuery(
    `
      select ${candidateColumns()}
      from public.marketplace_search_candidates c
      where c.card_id = any($1::bigint[])
    `,
    [ids],
  );
  return result.rows;
}

async function readCardsForSet(setName, limit = 12, offset = 0) {
  const name = String(setName || '').trim();
  // Must exceed marketplace-expansion-page parseLimit max (400) plus the +1
  // hasMore peek. A 64-row cap made limit=200 return 64 with hasMore false.
  const cap = Math.min(Math.max(Number(limit) || 12, 1), 500);
  const skip = Math.max(Number(offset) || 0, 0);
  if (!name) {
    return [];
  }
  const result = await marketplaceQuery(
    `
      select ${candidateColumns()}
      from public.marketplace_search_candidates c
      where c.item_kind = 'single'
        and c.product_type in ('card', 'jumbo')
        and c.set_name = $1
        and coalesce(c.cdn_image_url, c.image_url) is not null
      order by c.card_id desc
      limit $2
      offset $3
    `,
    [name, cap, skip],
  );
  return result.rows;
}

async function readNewestEnglishCards(limit = 24) {
  const cap = Math.min(Math.max(Number(limit) || 24, 1), 48);
  if (!isPokemonGame()) {
    const result = await marketplaceQuery(
      `
        select ${candidateColumns()}
        from public.marketplace_search_candidates c
        where c.item_kind = 'single'
          and c.product_type = 'card'
          and coalesce(c.cdn_image_url, c.image_url) is not null
        order by c.imported_at desc nulls last, c.card_id desc
        limit $1
      `,
      [cap],
    );
    return result.rows;
  }
  const slices = [
    ['Storm Emeralda', Math.min(12, cap)],
    ['Mega Evolution', Math.min(8, cap)],
    ['Phantasmal Flames', Math.min(8, cap)],
    ['Black Bolt', Math.min(8, cap)],
  ];
  const batches = await Promise.all(
    slices.map(([setName, size]) => readCardsForSet(setName, size)),
  );
  const byId = new Map();
  for (const row of batches.flat()) {
    const id = String(row.card_id || '');
    if (id && !byId.has(id)) {
      byId.set(id, row);
    }
  }
  return [...byId.values()].slice(0, cap);
}

async function readHotCards(limit = 12) {
  const cap = Math.min(Math.max(Number(limit) || 12, 1), 24);
  if (!isPokemonGame()) {
    const result = await marketplaceQuery(
      `
        select ${candidateColumns()}
        from public.marketplace_search_candidates c
        where c.item_kind = 'single'
          and c.product_type = 'card'
          and coalesce(c.cdn_image_url, c.image_url) is not null
        order by c.search_weight desc, c.card_id desc
        limit $1
      `,
      [cap],
    );
    return result.rows;
  }
  const result = await marketplaceQuery(
    `
      select ${candidateColumns()}, h.hot_score_24h
      from public.marketplace_hot_blueprints h
      join public.marketplace_search_candidates c
        on c.ct_id = h.blueprint_id
      where c.item_kind = 'single'
        and c.product_type = 'card'
        and coalesce(c.cdn_image_url, c.image_url) is not null
      order by h.hot_score_24h desc nulls last, c.card_id desc
      limit $1
    `,
    [cap],
  );
  return result.rows;
}

function splitNeighborRows(rows, radius = 6) {
  const cap = Math.min(Math.max(Number(radius) || 6, 1), 8);
  const prev = [];
  const next = [];
  for (const row of rows || []) {
    const distNext = Number(row.dist_next);
    const distPrev = Number(row.dist_prev);
    if (distNext >= 1 && distNext <= cap) {
      next.push(row);
    }
    if (distPrev >= 1 && distPrev <= cap) {
      prev.push(row);
    }
  }
  next.sort((a, b) => Number(a.dist_next) - Number(b.dist_next));
  prev.sort((a, b) => Number(a.dist_prev) - Number(b.dist_prev));
  return { prev, next };
}

async function readSetNeighbors(setName, cardId, radius = 6) {
  const name = String(setName || '').trim();
  const id = Number(cardId);
  const cap = Math.min(Math.max(Number(radius) || 6, 1), 8);
  if (!name || !Number.isSafeInteger(id) || id <= 0) {
    return { prev: [], next: [] };
  }
  const result = await marketplaceQuery(
    `
      with ordered as (
        select ${candidateColumns()},
          row_number() over (
            order by coalesce(
              (regexp_match(coalesce(c.card_number::text, ''), '[0-9]+'))[1]::int,
              2147483647
            ),
            c.card_id
          ) as rn,
          count(*) over () as n
        from public.marketplace_search_candidates c
        where c.item_kind = 'single'
          and c.product_type = 'card'
          and c.set_name = $1
          and coalesce(c.cdn_image_url, c.image_url) is not null
      ),
      cur as (
        select card_id, rn, n
        from ordered
        where card_id = $2
      )
      select
        o.card_id,
        o.ct_id,
        o.name,
        o.image_url,
        o.cdn_image_url,
        o.preview_image_url,
        o.homepage_image_url,
        o.set_name,
        o.rarity,
        o.card_number,
        o.item_kind,
        o.product_type,
        ((o.rn - cur.rn + cur.n) % cur.n)::int as dist_next,
        ((cur.rn - o.rn + cur.n) % cur.n)::int as dist_prev
      from ordered o
      cross join cur
      where o.card_id <> cur.card_id
        and (
          ((o.rn - cur.rn + cur.n) % cur.n) between 1 and $3
          or ((cur.rn - o.rn + cur.n) % cur.n) between 1 and $3
        )
    `,
    [name, id, cap],
  );
  return splitNeighborRows(result.rows, cap);
}

async function readSetSiblings(row, limit = 8) {
  const cardId = Number(row?.card_id || row?.id);
  if (isPokemonGame() && Number.isSafeInteger(cardId) && cardId > 0) {
    const cap = Math.min(Math.max(Number(limit) || 24, 1), 128);
    const byVersion = await marketplaceQuery(
      `
        select ${candidateColumns()}
        from public.marketplace_search_candidates c
        where c.item_kind = 'single'
          and c.product_type = 'card'
          and c.version is not null
          and c.version = (
            select version
            from public.marketplace_search_candidates
            where card_id = $1
          )
        order by c.card_id
        limit $2
      `,
      [cardId, cap],
    );
    if (byVersion.rows.length) {
      return byVersion.rows;
    }
  }
  return readNameSetSiblings(row, limit);
}

/** Same English name + expansion: UR / FA / SIR / Gold. CLIP version is a different art. */
async function readNameSetSiblings(row, limit = 24) {
  const name = String(row?.name || '').trim();
  const setName = String(row?.set_name || row?.set || '').trim();
  if (!name || !setName) {
    return row ? [row] : [];
  }
  const cap = Math.min(Math.max(Number(limit) || 24, 1), 48);
  const result = await marketplaceQuery(
    `
      select ${candidateColumns()}
      from public.marketplace_search_candidates c
      where c.item_kind = 'single'
        and c.product_type = 'card'
        and c.name = $1
        and c.set_name = $2
        and coalesce(c.cdn_image_url, c.image_url) is not null
      order by c.card_id desc
      limit $3
    `,
    [name, setName, cap],
  );
  return result.rows.length ? result.rows : (row ? [row] : []);
}

async function readCanonicalPaths(cardIds) {
  const ids = [...new Set((cardIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const map = new Map();
  if (ids.length === 0) {
    return map;
  }
  const result = await marketplaceQuery(
    `
      select distinct on (card_id)
        card_id::text as card_id,
        canonical_path::text as canonical_path
      from public.marketplace_card_urls
      where card_id = any($1::bigint[])
        and language = 'en'
      order by card_id, canonical_path
    `,
    [ids],
  );
  for (const row of result.rows) {
    if (row.card_id && row.canonical_path) {
      map.set(String(row.card_id), String(row.canonical_path));
    }
  }
  return map;
}

async function readCheapestMap(cardIds, blueprintIds) {
  const publicIds = [...new Set((cardIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const blueprints = [...new Set((blueprintIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const byCardId = new Map();
  const byBlueprint = new Map();
  if (!isPokemonGame() || (publicIds.length === 0 && blueprints.length === 0)) {
    return { byCardId, byBlueprint };
  }
  try {
    const result = await marketplaceQuery(
      `
        select
          pokoin_card_id,
          blueprint_id,
          cheapest_price_pkn,
          eligible_listing_count,
          eligible_quantity,
          provider
        from public.cheapest_homepage_cache_blueprint
        where provider in ('cardtrader', 'pokoin_native')
          and cheapest_price_pkn is not null
          and cheapest_price_pkn > 0
          and coalesce(eligible_listing_count, 0) > 0
          and (
            pokoin_card_id = any($1::text[])
            or blueprint_id = any($2::bigint[])
          )
      `,
      [publicIds, blueprints],
    );
    for (const row of result.rows) {
      const entry = {
        price: Number(row.cheapest_price_pkn),
        stock: Number(row.eligible_quantity || row.eligible_listing_count || 0),
        hasCardTraderListing: row.provider === 'cardtrader',
        provider: row.provider,
      };
      if (row.pokoin_card_id) {
        byCardId.set(String(row.pokoin_card_id), entry);
      }
      if (row.blueprint_id != null) {
        byBlueprint.set(String(row.blueprint_id), entry);
      }
    }
  } catch (_) {
    /* Multigame DBs omit cheapest cache. */
  }
  return { byCardId, byBlueprint };
}

async function readVersionSetMeta(cardId) {
  if (!isPokemonGame()) {
    return null;
  }
  const id = Number(cardId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  const result = await marketplaceQuery(
    `
      select s.version, s.member_count
      from public.marketplace_search_candidates c
      join public.pokoin_version_sets s on s.version = c.version
      where c.card_id = $1::bigint
      limit 1
    `,
    [id],
  );
  return result.rows[0] || null;
}


function applyCanonicalAndCheapest(rows, paths, cheapest) {
  return (rows || []).map((row) => {
    const id = String(row.card_id || '');
    const path = paths.get(id);
    const hit = cheapest.byCardId.get(id)
      || cheapest.byBlueprint.get(String(row.ct_id || row.blueprint_id || ''));
    return {
      ...row,
      canonical_path: path || row.canonical_path || '',
      lowest_price_pkn: hit && Number.isFinite(hit.price) ? hit.price : row.lowest_price_pkn,
      listed_quantity: hit ? hit.stock : row.listed_quantity,
      has_cardtrader_listing: hit ? hit.hasCardTraderListing : row.has_cardtrader_listing,
      cardtrader_eligible_listing_count: hit && hit.hasCardTraderListing ? hit.stock : 0,
    };
  });
}

async function overlayCheapestOnRows(rows, readCheapest = readCheapestMap) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return list;
  }
  try {
    const ids = list.map((row) => String(row.card_id || row.id || '')).filter(Boolean);
    const blueprints = list
      .map((row) => Number(row.ct_id || row.blueprint_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    const cheapest = await readCheapest(ids, blueprints);
    return applyCanonicalAndCheapest(list, new Map(), cheapest);
  } catch (_) {
    return list;
  }
}

/** Leftover illustration shade rows per CardTrader id: `shade` (#rrggbb,
 * source metadata) plus `artwork_identity` (sha256 of the canonical JPEG,
 * the theme validity key). Falls back to the pre-085 shape (empty
 * identity) while the column is not applied yet, so the shade keeps
 * working. */
async function readArtShadeRows(ctIds) {
  const ids = [...new Set((ctIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) {
    return new Map();
  }
  try {
    const result = await marketplaceQuery(
      `
        select ct_id, shade, coalesce(artwork_identity, '') as artwork_identity
        from public.marketplace_leftover_art_shades
        where ct_id = any($1::bigint[])
      `,
      [ids],
    );
    return new Map(result.rows.map((row) => [Number(row.ct_id), row]));
  } catch (error) {
    if (!/artwork_identity/.test(String(error?.message || error))) {
      throw error;
    }
    const result = await marketplaceQuery(
      `
        select ct_id, shade, '' as artwork_identity
        from public.marketplace_leftover_art_shades
        where ct_id = any($1::bigint[])
      `,
      [ids],
    );
    return new Map(result.rows.map((row) => [Number(row.ct_id), row]));
  }
}

/** Leftover illustration caption shade per CardTrader id (`#rrggbb`). The
 * artist-cards API joins the same table for album tiles (`--album-shade`). */
async function readArtShades(ctIds) {
  const rows = await readArtShadeRows(ctIds);
  return new Map([...rows].map(([ctId, row]) => [ctId, String(row.shade || '')]));
}

/** Packed card themes (`vt`, 44-char `v1` + 7 hexes) per public card id.
 * One round trip: resolves ct_id via candidates, then reads the persisted
 * theme plus the current shade/identity and packs the authoritative theme
 * (re-deriving when the persisted row is missing, unverifiable, or stale).
 * Cards without a usable shade get no pack. */
async function readCardThemePacks(cardIds) {
  const ids = [...new Set((cardIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) {
    return new Map();
  }
  const values = [];
  const keys = ids.map((id, index) => {
    values.push(id);
    return `($${index + 1}::bigint)`;
  });
  const result = await marketplaceQuery(
    `
      with wanted as (select card_id from (values ${keys.join(', ')}) as w(card_id))
      select w.card_id,
             coalesce(nullif(s.shade, ''), '') as shade,
             coalesce(nullif(s.artwork_identity, ''), '') as current_identity,
             t.version as theme_version,
             coalesce(nullif(t.artwork_identity, ''), '') as theme_identity,
             t.artwork_shade as theme_shade,
             t.hue as theme_hue,
             t.chroma as theme_chroma,
             t.background as theme_background,
             t.surface as theme_surface,
             t.surface_raised as theme_surface_raised,
             t.hero as theme_hero,
             t.hero_border as theme_hero_border,
             t.border as theme_border,
             t.tint as theme_tint
      from wanted w
      join public.marketplace_search_candidates c on c.card_id = w.card_id
      left join public.marketplace_leftover_art_shades s on s.ct_id = c.ct_id
      left join public.marketplace_leftover_visual_themes t on t.ct_id = c.ct_id
    `,
    values,
  );
  const { visualThemeForShade, packVisualTheme } = require('./_card_visual_theme');
  const packs = new Map();
  for (const row of result.rows) {
    const theme = visualThemeForShade(
      {
        version: row.theme_version,
        artwork_identity: row.theme_identity,
        hue: row.theme_hue,
        chroma: row.theme_chroma,
        background: row.theme_background,
        surface: row.theme_surface,
        surface_raised: row.theme_surface_raised,
        hero: row.theme_hero,
        hero_border: row.theme_hero_border,
        border: row.theme_border,
        tint: row.theme_tint,
      },
      row.shade,
      row.current_identity,
    );
    const packed = packVisualTheme(theme);
    if (packed) {
      packs.set(String(row.card_id), packed);
    }
  }
  return packs;
}

/** Persisted card visual themes (084) per CardTrader id. Rows carry their
 * source artwork_shade; the card-page endpoint re-derives stale ones. */
async function readVisualThemes(ctIds) {
  const ids = [...new Set((ctIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) {
    return new Map();
  }
  const result = await marketplaceQuery(
    `
      select ct_id, version, artwork_shade, coalesce(artwork_identity, '') as artwork_identity,
             hue, chroma, background, surface, surface_raised,
             hero, hero_border, border, tint
      from public.marketplace_leftover_visual_themes
      where ct_id = any($1::bigint[])
    `,
    [ids],
  );
  return new Map(result.rows.map((row) => [Number(row.ct_id), row]));
}

module.exports = {
  NEWEST_ENGLISH_SET_NAMES,
  candidateColumns,
  readStoredCatalogCardCount,
  readExpansionBySlug,
  readExpansionsFromSetCounts,
  readCandidateByCardId,
  readCandidatesByCardIds,
  readCardsForSet,
  readNewestEnglishCards,
  readHotCards,
  readSetSiblings,
  readNameSetSiblings,
  readSetNeighbors,
  splitNeighborRows,
  readCanonicalPaths,
  readCheapestMap,
  readVersionSetMeta,
  applyCanonicalAndCheapest,
  overlayCheapestOnRows,
  expansionSlugSql,
  readArtShades,
  readArtShadeRows,
  readVisualThemes,
  readCardThemePacks,
};
