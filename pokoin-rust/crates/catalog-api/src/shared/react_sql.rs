//! Port of `_marketplace_react_sql.js` — indexed lookups for React page BFFs.
//!
//! Do not ORDER BY imported_at on the full candidates table (no index;
//! statement timeout). Prefer card_id, set_name equality, or
//! hot_blueprints.blueprint_id = ct_id. Every statement is the live Node SQL,
//! verbatim; rows come back as `to_jsonb` JSON objects. Each function takes
//! the game's pool (pokemon = the replica, `state.api.read()`) and an
//! explicit `is_pokemon` flag where the JS branched on `isPokemonGame()`.

use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;

use super::{card_visual_theme, js};

pub const NEWEST_ENGLISH_SET_NAMES: [&str; 13] = [
    "Mega Evolution",
    "Phantasmal Flames",
    "Black Bolt",
    "White Flare",
    "Destined Rivals",
    "Journey Together",
    "Prismatic Evolutions",
    "Surging Sparks",
    "Stellar Crown",
    "Shrouded Fable",
    "Twilight Masquerade",
    "Temporal Forces",
    "Paldean Fates",
];

const CANDIDATE_COLUMNS_BASE: &str = "
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
";

/// Pokemon candidates have `version`, `emoji` (060) and denormed
/// illustrator. Isolated satellite catalogs (Magic, OP, RB, …) do not:
/// selecting them there fails every card-page lookup with 42703.
pub fn candidate_columns(is_pokemon: bool) -> String {
    if is_pokemon {
        format!(
            "{CANDIDATE_COLUMNS_BASE},
  c.emoji,
  c.version,
  coalesce(c.rarity_kind, '') as rarity_kind,
  coalesce(c.art_layout, '') as art_layout,
  coalesce(c.artist, '') as artist,
  coalesce(c.illustrator, '') as illustrator"
        )
    } else {
        format!(
            "{CANDIDATE_COLUMNS_BASE},
  ''::text as emoji,
  null::text as version,
  null::text as rarity_kind,
  null::text as art_layout,
  null::text as artist,
  null::text as illustrator"
        )
    }
}

/// `readStoredCatalogCardCount(setName)`.
pub async fn read_stored_catalog_card_count(
    pool: &PgPool,
    is_pokemon: bool,
    set_name: &str,
) -> Result<i64, sqlx::Error> {
    let name = set_name.trim();
    if name.is_empty() {
        return Ok(0);
    }
    let sql = if is_pokemon {
        "
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
      "
    } else {
        "
      select catalog_card_count
      from public.marketplace_set_card_counts
      where set_name = $1
      limit 1
    "
    };
    let count: Option<i32> = super::sql_json::scalar(
        pool,
        sql,
        &[super::sql_json::SqlBind::Text(name.to_string())],
    )
    .await?;
    Ok(count.map(|n| n as i64).unwrap_or(0))
}

/// `expansionSlugSql(column)` — JS slugify in SQL: unaccent (Pokémon ->
/// Pokemon) then `&` -> ` and ` before non-alnum.
pub fn expansion_slug_sql(column: &str) -> String {
    format!("trim(both '-' from lower(regexp_replace(replace(public.unaccent({column}), '&', ' and '), '[^a-zA-Z0-9]+', '-', 'g')))")
}

/// `readExpansionBySlug(slug)`.
pub async fn read_expansion_by_slug(
    pool: &PgPool,
    is_pokemon: bool,
    slug: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let key = slug.trim().to_lowercase();
    if key.is_empty() {
        return Ok(None);
    }
    if is_pokemon {
        let sql = format!(
            "
        select
          name,
          symbol_image_url,
          logo_image_url,
          catalog_card_count,
          nationality
        from public.pokoin_pokemon_expansions
        where {} = $1
        limit 1
      ",
            expansion_slug_sql("name")
        );
        if let Some(row) =
            super::sql_json::row_json(pool, &sql, &[super::sql_json::SqlBind::Text(key.clone())])
                .await?
        {
            let stored = js::number(js::get(&row, "catalog_card_count"));
            let stored = if stored.is_finite() { stored } else { 0.0 };
            let name = js::string_or_empty(js::get(&row, "name"));
            let card_count = if stored != 0.0 {
                stored
            } else {
                read_stored_catalog_card_count(pool, true, &name).await? as f64
            };
            return Ok(Some(expansion_from_pokemon_row(&row, &key, card_count)));
        }
    }
    // Every satellite DB has pokoin_pokemon_expansions (logo rows are
    // optional). Wordmarks stamped there are the set-guide art; an empty
    // logo stays the letter mark.
    let slug_expr = expansion_slug_sql("c.set_name");
    let sql = if is_pokemon {
        format!(
            "
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
         or {slug_expr} = $1
      order by c.catalog_card_count desc
      limit 1
    "
        )
    } else {
        format!(
            "
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
         or {slug_expr} = $1
      order by c.catalog_card_count desc
      limit 1
    "
        )
    };
    let row = super::sql_json::row_json(pool, &sql, &[super::sql_json::SqlBind::Text(key.clone())])
        .await?;
    Ok(row.map(|row| expansion_from_set_count(&row, &key)))
}

/// The pokemon-branch expansion mapping of `readExpansionBySlug`.
pub fn expansion_from_pokemon_row(row: &Value, slug: &str, card_count: f64) -> Value {
    json!({
        "name": js::string_or_empty(js::get(row, "name")),
        "slug": slug,
        "symbolImageUrl": js::string_or_empty(js::get(row, "symbol_image_url")),
        "logoImageUrl": js::string_or_empty(js::get(row, "logo_image_url")),
        "defaultSymbolUrl": format!("https://cdn.pokoin.com/expansions/symbols/{slug}.png"),
        "cardCount": js::js_json_number(card_count),
        "nationality": js::string_or_empty(js::get(row, "nationality")).trim().to_lowercase(),
    })
}

/// `expansionFromSetCount(row, slugFallback)`.
pub fn expansion_from_set_count(row: &Value, slug_fallback: &str) -> Value {
    let name = js::string_or_empty(js::get(row, "name")).trim().to_string();
    let mut slug = js::string_or_empty(js::get(row, "slug"))
        .trim()
        .to_lowercase();
    if slug.is_empty() {
        slug = slug_fallback.trim().to_lowercase();
    }
    if slug.is_empty() {
        slug = name
            .to_lowercase()
            .replace('&', " and ")
            .chars()
            .map(|ch| {
                if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
                    ch
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .trim_matches('-')
            .to_string();
    }
    let count = js::number(js::get(row, "catalog_card_count"));
    json!({
        "name": name,
        "slug": slug,
        "symbolImageUrl": js::string_or_empty(js::get(row, "symbol_image_url")).trim(),
        "logoImageUrl": js::string_or_empty(js::get(row, "logo_image_url")).trim(),
        "defaultSymbolUrl": "",
        "cardCount": js::js_json_number(if count.is_finite() { count } else { 0.0 }),
        "nationality": js::string_or_empty(js::get(row, "nationality")).trim().to_lowercase(),
    })
}

/// `readExpansionsFromSetCounts(limit)`.
pub async fn read_expansions_from_set_counts(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let base = if limit == 0 { 500 } else { limit };
    let cap = base.clamp(1, 2000);
    let sql = "
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
    ";
    let rows = super::sql_json::rows_json(pool, sql, &[super::sql_json::SqlBind::Int(cap)]).await?;
    Ok(rows
        .iter()
        .map(|row| expansion_from_set_count(row, ""))
        .collect())
}

/// `readCandidateByCardId(cardId)`.
pub async fn read_candidate_by_card_id(
    pool: &PgPool,
    is_pokemon: bool,
    card_id: i64,
) -> Result<Option<Value>, sqlx::Error> {
    if card_id <= 0 {
        return Ok(None);
    }
    let sql = format!(
        "
      select {}
      from public.marketplace_search_candidates c
      where c.card_id = $1::bigint
      limit 1
    ",
        candidate_columns(is_pokemon)
    );
    super::sql_json::row_json(pool, &sql, &[super::sql_json::SqlBind::Int(card_id)]).await
}

/// `readCandidatesByCardIds(cardIds)` — deduplicated, positive ids only.
pub async fn read_candidates_by_card_ids(
    pool: &PgPool,
    is_pokemon: bool,
    card_ids: &[i64],
) -> Result<Vec<Value>, sqlx::Error> {
    let ids = unique_positive(card_ids.iter().copied());
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "
      select {}
      from public.marketplace_search_candidates c
      where c.card_id = any($1::bigint[])
    ",
        candidate_columns(is_pokemon)
    );
    super::sql_json::rows_json(
        pool,
        &sql,
        &[super::sql_json::SqlBind::BigIntArray(ids.clone())],
    )
    .await
}

/// `readCardsForSet(setName, limit, offset)`.
pub async fn read_cards_for_set(
    pool: &PgPool,
    is_pokemon: bool,
    set_name: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let name = set_name.trim();
    // Must exceed marketplace-expansion-page parseLimit max (400) plus the
    // +1 hasMore peek. A 64-row cap made limit=200 return 64 with hasMore
    // false.
    let base = if limit == 0 { 12 } else { limit };
    let cap = base.clamp(1, 500);
    let skip = offset.max(0);
    if name.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "
      select {}
      from public.marketplace_search_candidates c
      where c.item_kind = 'single'
        and c.product_type in ('card', 'jumbo')
        and c.set_name = $1
        and coalesce(c.cdn_image_url, c.image_url) is not null
      order by c.card_id desc
      limit $2
      offset $3
    ",
        candidate_columns(is_pokemon)
    );
    super::sql_json::rows_json(
        pool,
        &sql,
        &[
            super::sql_json::SqlBind::Text(name.to_string()),
            super::sql_json::SqlBind::Int(cap),
            super::sql_json::SqlBind::Int(skip),
        ],
    )
    .await
}

/// `readNewestEnglishCards(limit)`.
pub async fn read_newest_english_cards(
    pool: &PgPool,
    is_pokemon: bool,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let base = if limit == 0 { 24 } else { limit };
    let cap = base.clamp(1, 48);
    if !is_pokemon {
        let sql = format!(
            "
        select {}
        from public.marketplace_search_candidates c
        where c.item_kind = 'single'
          and c.product_type = 'card'
          and coalesce(c.cdn_image_url, c.image_url) is not null
        order by c.imported_at desc nulls last, c.card_id desc
        limit $1
      ",
            candidate_columns(false)
        );
        return super::sql_json::rows_json(pool, &sql, &[super::sql_json::SqlBind::Int(cap)]).await;
    }
    let slices = [
        ("Storm Emeralda", cap.min(12)),
        ("Mega Evolution", cap.min(8)),
        ("Phantasmal Flames", cap.min(8)),
        ("Black Bolt", cap.min(8)),
    ];
    let mut batches = Vec::new();
    for (set_name, size) in slices {
        batches.push(read_cards_for_set(pool, true, set_name, size, 0).await?);
    }
    let mut by_id: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for batch in batches {
        for row in batch {
            let id = js::string_or_empty(js::get(&row, "card_id"));
            if !id.is_empty() && seen.insert(id) {
                by_id.push(row);
            }
        }
    }
    by_id.truncate(cap as usize);
    Ok(by_id)
}

/// `readHotCards(limit)`.
pub async fn read_hot_cards(
    pool: &PgPool,
    is_pokemon: bool,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let base = if limit == 0 { 12 } else { limit };
    let cap = base.clamp(1, 24);
    if !is_pokemon {
        let sql = format!(
            "
        select {}
        from public.marketplace_search_candidates c
        where c.item_kind = 'single'
          and c.product_type = 'card'
          and coalesce(c.cdn_image_url, c.image_url) is not null
        order by c.search_weight desc, c.card_id desc
        limit $1
      ",
            candidate_columns(false)
        );
        return super::sql_json::rows_json(pool, &sql, &[super::sql_json::SqlBind::Int(cap)]).await;
    }
    let sql = format!(
        "
      select {}, h.hot_score_24h
      from public.marketplace_hot_blueprints h
      join public.marketplace_search_candidates c
        on c.ct_id = h.blueprint_id
      where c.item_kind = 'single'
        and c.product_type = 'card'
        and coalesce(c.cdn_image_url, c.image_url) is not null
      order by h.hot_score_24h desc nulls last, c.card_id desc
      limit $1
    ",
        candidate_columns(true)
    );
    super::sql_json::rows_json(pool, &sql, &[super::sql_json::SqlBind::Int(cap)]).await
}

/// `splitNeighborRows(rows, radius)` — `(prev, next)` ordered by distance.
pub fn split_neighbor_rows(rows: &[Value], radius: i64) -> (Vec<Value>, Vec<Value>) {
    let base = if radius == 0 { 6 } else { radius };
    let cap = base.clamp(1, 8);
    let mut prev = Vec::new();
    let mut next = Vec::new();
    for row in rows {
        let dist_next = js::number(js::get(row, "dist_next"));
        let dist_prev = js::number(js::get(row, "dist_prev"));
        if dist_next >= 1.0 && dist_next <= cap as f64 {
            next.push(row.clone());
        }
        if dist_prev >= 1.0 && dist_prev <= cap as f64 {
            prev.push(row.clone());
        }
    }
    next.sort_by(|a, b| {
        pokoin_sort::cmp_f64(js::number(js::get(a, "dist_next")), js::number(js::get(b, "dist_next")))
    });
    prev.sort_by(|a, b| {
        pokoin_sort::cmp_f64(js::number(js::get(a, "dist_prev")), js::number(js::get(b, "dist_prev")))
    });
    (prev, next)
}

/// `readSetNeighbors(setName, cardId, radius)`.
pub async fn read_set_neighbors(
    pool: &PgPool,
    is_pokemon: bool,
    set_name: &str,
    card_id: i64,
    radius: i64,
) -> Result<(Vec<Value>, Vec<Value>), sqlx::Error> {
    let name = set_name.trim();
    let base = if radius == 0 { 6 } else { radius };
    let cap = base.clamp(1, 8);
    if name.is_empty() || card_id <= 0 {
        return Ok((Vec::new(), Vec::new()));
    }
    let sql = format!(
        "
      with ordered as (
        select {},
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
    ",
        candidate_columns(is_pokemon)
    );
    let rows = super::sql_json::rows_json(
        pool,
        &sql,
        &[
            super::sql_json::SqlBind::Text(name.to_string()),
            super::sql_json::SqlBind::Int(card_id),
            super::sql_json::SqlBind::Int(cap),
        ],
    )
    .await?;
    Ok(split_neighbor_rows(&rows, cap))
}

/// `readSetSiblings(row, limit)` — CLIP version-set siblings first.
pub async fn read_set_siblings(
    pool: &PgPool,
    is_pokemon: bool,
    row: &Value,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let card_id = js::number(js::get(row, "card_id").or_else(|| js::get(row, "id")));
    let card_id = if js::is_safe_integer(card_id) {
        card_id as i64
    } else {
        0
    };
    if is_pokemon && card_id > 0 {
        let base = if limit == 0 { 24 } else { limit };
        let cap = base.clamp(1, 128);
        let sql = format!(
            "
        select {}
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
      ",
            candidate_columns(true)
        );
        let by_version = super::sql_json::rows_json(
            pool,
            &sql,
            &[
                super::sql_json::SqlBind::Int(card_id),
                super::sql_json::SqlBind::Int(cap),
            ],
        )
        .await?;
        if !by_version.is_empty() {
            return Ok(by_version);
        }
    }
    read_name_set_siblings(pool, is_pokemon, row, limit).await
}

/// `readNameSetSiblings(row, limit)` — same English name + expansion:
/// UR / FA / SIR / Gold. CLIP version is a different art.
pub async fn read_name_set_siblings(
    pool: &PgPool,
    is_pokemon: bool,
    row: &Value,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let name = js::string_or_empty(js::get(row, "name")).trim().to_string();
    let set_name = js::string_or_empty(js::get(row, "set_name").or_else(|| js::get(row, "set")))
        .trim()
        .to_string();
    if name.is_empty() || set_name.is_empty() {
        return Ok(if row.is_null() {
            Vec::new()
        } else {
            vec![row.clone()]
        });
    }
    let base = if limit == 0 { 24 } else { limit };
    let cap = base.clamp(1, 48);
    let sql = format!(
        "
      select {}
      from public.marketplace_search_candidates c
      where c.item_kind = 'single'
        and c.product_type = 'card'
        and c.name = $1
        and c.set_name = $2
        and coalesce(c.cdn_image_url, c.image_url) is not null
      order by c.card_id desc
      limit $3
    ",
        candidate_columns(is_pokemon)
    );
    let rows = super::sql_json::rows_json(
        pool,
        &sql,
        &[
            super::sql_json::SqlBind::Text(name.clone()),
            super::sql_json::SqlBind::Text(set_name.clone()),
            super::sql_json::SqlBind::Int(cap),
        ],
    )
    .await?;
    if !rows.is_empty() {
        Ok(rows)
    } else if row.is_null() {
        Ok(Vec::new())
    } else {
        Ok(vec![row.clone()])
    }
}

/// `readCanonicalPaths(cardIds)` — card_id -> canonical path (English).
pub async fn read_canonical_paths(
    pool: &PgPool,
    card_ids: &[i64],
) -> Result<HashMap<String, String>, sqlx::Error> {
    let ids = unique_positive(card_ids.iter().copied());
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let sql = "
      select distinct on (card_id)
        card_id::text as card_id,
        canonical_path::text as canonical_path
      from public.marketplace_card_urls
      where card_id = any($1::bigint[])
        and language = 'en'
      order by card_id, canonical_path
    ";
    let rows = super::sql_json::rows_json(
        pool,
        sql,
        &[super::sql_json::SqlBind::BigIntArray(ids.clone())],
    )
    .await?;
    for row in rows {
        let card_id = js::string_or_empty(js::get(&row, "card_id"));
        let path = js::string_or_empty(js::get(&row, "canonical_path"));
        if !card_id.is_empty() && !path.is_empty() {
            map.insert(card_id, path);
        }
    }
    Ok(map)
}

/// The `cheapest` overlay maps: one entry per public card id and per
/// blueprint id.
#[derive(Debug, Default, Clone)]
pub struct CheapestMap {
    pub by_card_id: HashMap<String, Value>,
    pub by_blueprint: HashMap<String, Value>,
}

/// `readCheapestMap(cardIds, blueprintIds)`.
pub async fn read_cheapest_map(
    pool: &PgPool,
    is_pokemon: bool,
    card_ids: &[i64],
    blueprint_ids: &[i64],
) -> CheapestMap {
    let public_ids: Vec<String> = card_ids
        .iter()
        .map(|id| id.to_string())
        .filter(|id| !id.is_empty())
        .collect();
    let blueprints = unique_positive(blueprint_ids.iter().copied());
    let mut map = CheapestMap::default();
    if !is_pokemon || (public_ids.is_empty() && blueprints.is_empty()) {
        return map;
    }
    // Multigame DBs omit cheapest cache: any failure resolves to empty maps.
    let sql = "
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
      ";
    let rows = match super::sql_json::rows_json(
        pool,
        sql,
        &[
            super::sql_json::SqlBind::TextArray(public_ids.clone()),
            super::sql_json::SqlBind::BigIntArray(blueprints.clone()),
        ],
    )
    .await
    {
        Ok(rows) => rows,
        Err(_) => return map,
    };
    map = cheapest_map_from_rows(&rows);
    map
}

/// The `readCheapestMap` row loop, factored for tests and reuse.
pub fn cheapest_map_from_rows(rows: &[Value]) -> CheapestMap {
    let mut map = CheapestMap::default();
    for row in rows {
        let price = js::number(js::get(row, "cheapest_price_pkn"));
        let stock = js::number(js::truthy_chain(&[
            js::get(row, "eligible_quantity"),
            js::get(row, "eligible_listing_count"),
        ]));
        let provider = js::string_or_empty(js::get(row, "provider"));
        let entry = json!({
            "price": js::js_json_number(price),
            "stock": js::js_json_number(if stock.is_finite() { stock } else { 0.0 }),
            "hasCardTraderListing": provider == "cardtrader",
            "provider": provider,
        });
        let pokoin_card_id = js::get(row, "pokoin_card_id");
        if js::truthy(pokoin_card_id) {
            map.by_card_id
                .insert(js::string_or_empty(pokoin_card_id), entry.clone());
        }
        let blueprint_id = js::get(row, "blueprint_id");
        if !matches!(blueprint_id, None | Some(Value::Null)) {
            map.by_blueprint
                .insert(js::string_or_empty(blueprint_id), entry);
        }
    }
    map
}

/// `readVersionSetMeta(cardId)`.
pub async fn read_version_set_meta(
    pool: &PgPool,
    is_pokemon: bool,
    card_id: i64,
) -> Result<Option<Value>, sqlx::Error> {
    if !is_pokemon || card_id <= 0 {
        return Ok(None);
    }
    let sql = "
      select s.version, s.member_count
      from public.marketplace_search_candidates c
      join public.pokoin_version_sets s on s.version = c.version
      where c.card_id = $1::bigint
      limit 1
    ";
    super::sql_json::row_json(pool, sql, &[super::sql_json::SqlBind::Int(card_id)]).await
}

/// `applyCanonicalAndCheapest(rows, paths, cheapest)`.
pub fn apply_canonical_and_cheapest(
    rows: &[Value],
    paths: &HashMap<String, String>,
    cheapest: &CheapestMap,
) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let id = js::string_or_empty(js::get(row, "card_id"));
            let path = paths.get(&id);
            let ct_key = js::string_or_empty(js::get(row, "ct_id"));
            let ct_key = if ct_key.is_empty() {
                js::string_or_empty(js::get(row, "blueprint_id"))
            } else {
                ct_key
            };
            let hit = cheapest
                .by_card_id
                .get(&id)
                .or_else(|| cheapest.by_blueprint.get(&ct_key));

            let mut map = row.as_object().cloned().unwrap_or_default();
            let path_value = match path {
                Some(p) => Value::String(p.clone()),
                None => js::or(
                    js::get(row, "canonical_path"),
                    &Value::String(String::new()),
                )
                .clone(),
            };
            js::set(&mut map, "canonical_path", path_value);

            match hit {
                Some(hit) => {
                    let price = js::number(js::get(hit, "price"));
                    if price.is_finite() {
                        js::set(&mut map, "lowest_price_pkn", js::js_json_number(price));
                    } else if let Some(value) = js::get(row, "lowest_price_pkn") {
                        js::set(&mut map, "lowest_price_pkn", value.clone());
                    }
                    js::set(
                        &mut map,
                        "listed_quantity",
                        js::get(hit, "stock").cloned().unwrap_or(Value::Null),
                    );
                    js::set(
                        &mut map,
                        "has_cardtrader_listing",
                        js::get(hit, "hasCardTraderListing")
                            .cloned()
                            .unwrap_or(Value::Null),
                    );
                    let is_ct = js::get(hit, "hasCardTraderListing") == Some(&Value::Bool(true));
                    js::set(
                        &mut map,
                        "cardtrader_eligible_listing_count",
                        if is_ct {
                            js::get(hit, "stock").cloned().unwrap_or(Value::Null)
                        } else {
                            json!(0)
                        },
                    );
                }
                None => {
                    // `{ ...row, lowest_price_pkn: row.lowest_price_pkn }`:
                    // absent source keys stay absent (undefined drops).
                    if let Some(value) = js::get(row, "lowest_price_pkn") {
                        js::set(&mut map, "lowest_price_pkn", value.clone());
                    }
                    if let Some(value) = js::get(row, "listed_quantity") {
                        js::set(&mut map, "listed_quantity", value.clone());
                    }
                    if let Some(value) = js::get(row, "has_cardtrader_listing") {
                        js::set(&mut map, "has_cardtrader_listing", value.clone());
                    }
                    js::set(&mut map, "cardtrader_eligible_listing_count", json!(0));
                }
            }
            Value::Object(map)
        })
        .collect()
}

/// `overlayCheapestOnRows` with a caller-supplied cheapest map (the pure
/// half of the overlay; the route test drives this with captured rows).
pub fn overlay_cheapest_with(rows: &[Value], cheapest: &CheapestMap) -> Vec<Value> {
    apply_canonical_and_cheapest(rows, &HashMap::new(), cheapest)
}

/// `overlayCheapestOnRows(rows)` — cheapest overlay with failures resolving
/// to the unchanged rows.
pub async fn overlay_cheapest_on_rows(
    pool: &PgPool,
    is_pokemon: bool,
    rows: &[Value],
) -> Vec<Value> {
    if rows.is_empty() {
        return rows.to_vec();
    }
    let ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| {
            let raw = js::get(row, "card_id").or_else(|| js::get(row, "id"))?;
            let n = js::number(Some(raw));
            js::is_safe_integer(n).then_some(n as i64)
        })
        .filter(|n| *n > 0)
        .collect();
    let blueprints: Vec<i64> = rows
        .iter()
        .filter_map(|row| {
            let raw = js::get(row, "ct_id").or_else(|| js::get(row, "blueprint_id"))?;
            let n = js::number(Some(raw));
            js::is_safe_integer(n).then_some(n as i64)
        })
        .filter(|n| *n > 0)
        .collect();
    let cheapest = read_cheapest_map(pool, is_pokemon, &ids, &blueprints).await;
    apply_canonical_and_cheapest(rows, &HashMap::new(), &cheapest)
}

/// `readArtShadeRows(ctIds)` — leftover illustration shade rows per CardTrader
/// id (`shade` plus `artwork_identity`). Falls back to the pre-085 shape
/// (empty identity) while the column is not applied yet.
pub async fn read_art_shade_rows(
    pool: &PgPool,
    ct_ids: &[i64],
) -> Result<HashMap<i64, Value>, sqlx::Error> {
    let ids = unique_positive(ct_ids.iter().copied());
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let sql = "
        select ct_id, shade, coalesce(artwork_identity, '') as artwork_identity
        from public.marketplace_leftover_art_shades
        where ct_id = any($1::bigint[])
      ";
    let fallback_binds = &[super::sql_json::SqlBind::BigIntArray(ids.clone())];
    let rows = match super::sql_json::rows_json(pool, sql, fallback_binds).await {
        Ok(rows) => rows,
        Err(error) => {
            let message = error.to_string();
            if !message.contains("artwork_identity") {
                return Err(error);
            }
            super::sql_json::rows_json(
                pool,
                "
        select ct_id, shade, '' as artwork_identity
        from public.marketplace_leftover_art_shades
        where ct_id = any($1::bigint[])
      ",
                fallback_binds,
            )
            .await?
        }
    };
    for row in rows {
        let ct_id = js::number(js::get(&row, "ct_id"));
        if js::is_safe_integer(ct_id) {
            map.insert(ct_id as i64, row);
        }
    }
    Ok(map)
}

/// `readArtShades(ctIds)` — leftover illustration caption shade per CardTrader
/// id (`#rrggbb`). The artist-cards API joins the same table for album tiles
/// (`--album-shade`).
pub async fn read_art_shades(
    pool: &PgPool,
    ct_ids: &[i64],
) -> Result<HashMap<i64, String>, sqlx::Error> {
    let rows = read_art_shade_rows(pool, ct_ids).await?;
    Ok(rows
        .into_iter()
        .map(|(ct_id, row)| (ct_id, js::string_or_empty(js::get(&row, "shade"))))
        .collect())
}

/// `readCardThemePacks(cardIds)` — packed card themes (`vt`, 44-char `v1` +
/// 7 hexes) per public card id. One round trip: resolves ct_id via
/// candidates, then reads the persisted theme plus the current
/// shade/identity and packs the authoritative theme.
pub async fn read_card_theme_packs(
    pool: &PgPool,
    card_ids: &[i64],
) -> Result<HashMap<String, String>, sqlx::Error> {
    let ids = unique_positive(card_ids.iter().copied());
    let mut packs = HashMap::new();
    if ids.is_empty() {
        return Ok(packs);
    }
    let mut values = String::new();
    for (index, _) in ids.iter().enumerate() {
        if index > 0 {
            values.push_str(", ");
        }
        values.push_str(&format!("(${}::bigint)", index + 1));
    }
    let sql = format!(
        "
      with wanted as (select card_id from (values {values}) as w(card_id))
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
    "
    );
    let binds: Vec<super::sql_json::SqlBind> = ids
        .iter()
        .map(|id| super::sql_json::SqlBind::Int(*id))
        .collect();
    let rows = super::sql_json::rows_json(pool, &sql, &binds).await?;
    for row in rows {
        let theme_row = json!({
            "version": js::get(&row, "theme_version").cloned().unwrap_or(Value::Null),
            "artwork_identity": js::get(&row, "theme_identity").cloned().unwrap_or(Value::Null),
            "hue": js::get(&row, "theme_hue").cloned().unwrap_or(Value::Null),
            "chroma": js::get(&row, "theme_chroma").cloned().unwrap_or(Value::Null),
            "background": js::get(&row, "theme_background").cloned().unwrap_or(Value::Null),
            "surface": js::get(&row, "theme_surface").cloned().unwrap_or(Value::Null),
            "surface_raised": js::get(&row, "theme_surface_raised").cloned().unwrap_or(Value::Null),
            "hero": js::get(&row, "theme_hero").cloned().unwrap_or(Value::Null),
            "hero_border": js::get(&row, "theme_hero_border").cloned().unwrap_or(Value::Null),
            "border": js::get(&row, "theme_border").cloned().unwrap_or(Value::Null),
            "tint": js::get(&row, "theme_tint").cloned().unwrap_or(Value::Null),
        });
        let theme = card_visual_theme::visual_theme_for_shade(
            Some(&theme_row),
            &js::string_or_empty(js::get(&row, "shade")),
            &js::string_or_empty(js::get(&row, "current_identity")),
        );
        let packed = card_visual_theme::pack_visual_theme(theme.as_ref());
        if !packed.is_empty() {
            packs.insert(js::string_or_empty(js::get(&row, "card_id")), packed);
        }
    }
    Ok(packs)
}

/// `readVisualThemes(ctIds)` — persisted card visual themes (084) per
/// CardTrader id. Rows carry their source artwork_shade; the card-page
/// endpoint re-derives stale ones.
pub async fn read_visual_themes(
    pool: &PgPool,
    ct_ids: &[i64],
) -> Result<HashMap<i64, Value>, sqlx::Error> {
    let ids = unique_positive(ct_ids.iter().copied());
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let sql = "
      select ct_id, version, artwork_shade, coalesce(artwork_identity, '') as artwork_identity,
             hue, chroma, background, surface, surface_raised,
             hero, hero_border, border, tint
      from public.marketplace_leftover_visual_themes
      where ct_id = any($1::bigint[])
    ";
    let rows = super::sql_json::rows_json(
        pool,
        sql,
        &[super::sql_json::SqlBind::BigIntArray(ids.clone())],
    )
    .await?;
    for row in rows {
        let ct_id = js::number(js::get(&row, "ct_id"));
        if js::is_safe_integer(ct_id) {
            map.insert(ct_id as i64, row);
        }
    }
    Ok(map)
}

/// `[...new Set(ids)].filter(Number.isSafeInteger && > 0)`, insertion order.
fn unique_positive(ids: impl Iterator<Item = i64>) -> Vec<i64> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if id > 0 && seen.insert(id) {
            out.push(id);
        }
    }
    out
}
