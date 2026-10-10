//! `GET /api/marketplace-artist-cards` — port of `marketplace-artist-cards.js`.

use std::cmp::Ordering;

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use serde_json::{json, Value};

use super::util;
use crate::shared::{artist_display, artist_summary, card_emoji, card_rarity, js, react_sql};

fn slug_sql(column: &str) -> String {
    format!("trim(both '-' from regexp_replace(lower(coalesce({column}, '')), '[^a-z0-9]+', '-', 'g'))")
}

fn normalized_collector_number_sql(column: &str) -> String {
    format!(
        "coalesce(
    substring({column} from '([A-Za-z]*[0-9]+[A-Za-z]?\\s*/\\s*[0-9]+)'),
    substring({column} from '([A-Za-z]{{1,4}}\\s*[0-9]+)'),
    {column}
  )"
    )
}

fn normal_collector_sql(column: &str) -> String {
    let normalized = normalized_collector_number_sql(column);
    format!(
        "case
    when {normalized} ~ '^\\s*[0-9]+[A-Za-z]?\\s*(/[0-9]+)?\\s*$'
    then 0
    else 1
  end"
    )
}

/// This module's own `projectedExpansionNumberSql()` (versions columns only).
fn projected_expansion_number_sql() -> String {
    let image_source = "coalesce(
    versions.cdn_image_url,
    versions.image_url,
    versions.homepage_image_url,
    versions.preview_image_url,
    ''
  )";
    let image_collector = format!(
        "replace(
    substring({image_source} from '([0-9]{{1,4}}[A-Za-z]?[-/][0-9]{{1,4}})'),
    '-',
    '/'
  )"
    );
    format!(
        "coalesce(
    nullif(versions.expansion_number, ''),
    nullif({image_collector}, ''),
    versions.expansion_number
  )"
    )
}

fn projected_expansion_number_int_sql(expansion_number_sql: &str) -> String {
    format!(
        "coalesce(
    versions.expansion_number_int,
    nullif(substring({expansion_number_sql} from '([0-9]+)'), '')::integer
  )"
    )
}

fn leftover_image_sql() -> &'static str {
    "coalesce(
    nullif(versions.cdn_image_url, ''),
    nullif(versions.image_url, ''),
    nullif(versions.homepage_image_url, '')
  )"
}

fn cover_tier_sql() -> &'static str {
    "case
    when lower(versions.name) ~ '^pikachu([[:space:]]|$)' then 1
    when lower(versions.name) ~ '^(bulbasaur|charmander|squirtle)([[:space:]]|$)' then 2
    when lower(versions.name) ~ '^eevee([[:space:]]|$)' then 3
    else 4
  end"
}

fn s(row: &Value, key: &str) -> String {
    js::string_or_empty(row.get(key))
}

/// `leftoverArtistImage({ image_url })`.
fn leftover_artist_image(image_url: &str) -> String {
    let text = image_url.trim();
    let lower = text.to_lowercase();
    if text.is_empty() || lower.contains("/previews/") || lower.contains("/preview_") {
        return String::new();
    }
    text.to_owned()
}

/// `sameOriginArtistProfileImageUrl(value)`.
pub fn same_origin_artist_profile_image_url(value: &str) -> String {
    let clean = js::clean_text_str(value, 1000);
    if clean.is_empty() {
        return String::new();
    }
    if let Some(rest) = clean.strip_prefix("https://cdn.pokoin.com").or_else(|| clean.strip_prefix("http://cdn.pokoin.com")) {
        let path = rest.split(['?', '#']).next().unwrap_or("");
        if path.starts_with("/artist-profiles/") {
            return format!("https://pokoin.com/card-images{path}");
        }
    }
    clean
}

fn generated_profile_image_versioned_url(value: &str, generated: &Value) -> String {
    let image_url = same_origin_artist_profile_image_url(value);
    if image_url.is_empty() || generated.get("source").and_then(Value::as_str) != Some("card_art_fallback") {
        return image_url;
    }
    let version = js::clean_text(generated.get("generatedAt"), 120);
    if version.is_empty() {
        return image_url;
    }
    let encoded = serde_urlencoded::to_string([("v", version.as_str())]).unwrap_or_default();
    let (base, fragment) = match image_url.split_once('#') {
        Some((b, f)) => (b.to_owned(), format!("#{f}")),
        None => (image_url.clone(), String::new()),
    };
    let (path, query) = base.split_once('?').map(|(p, q)| (p.to_owned(), q.to_owned())).unwrap_or((base.clone(), String::new()));
    let mut pairs: Vec<String> = query.split('&').filter(|p| !p.is_empty() && !p.starts_with("v=") && *p != "v").map(str::to_owned).collect();
    pairs.push(encoded);
    format!("{path}?{}{fragment}", pairs.join("&"))
}

fn object_or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(v @ Value::Object(_)) => v.clone(),
        _ => json!({}),
    }
}

fn artist_profile_from_row(row: &Value) -> Value {
    let attribution = object_or_empty(row.get("profile_source_attribution"));
    let generated = object_or_empty(attribution.get("generatedProfileImage"));
    let image_source = [s(row, "profile_image_cdn_url"), s(row, "profile_image_url")].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
    json!({
        "displayName": artist_display::display_name_for_artist(row.get("normalized_artist"), row.get("profile_display_name"), first_truthy(row, &["artist", "illustrator"]).as_ref()),
        "summary": s(row, "profile_summary"),
        "bio": s(row, "profile_bio"),
        "imageUrl": generated_profile_image_versioned_url(&image_source, &generated),
        "sourceImageUrl": s(row, "profile_image_url"),
        "imageObjectKey": s(row, "profile_image_object_key"),
        "pocketmonstersUrl": s(row, "profile_pocketmonsters_url"),
        "pocketmonstersId": s(row, "profile_pocketmonsters_id"),
        "bulbapediaUrl": s(row, "profile_bulbapedia_url"),
        "bulbapediaTitle": s(row, "profile_bulbapedia_title"),
        "sourceName": s(row, "profile_source_name"),
        "sourceUrl": s(row, "profile_source_url"),
        "sourceAttribution": attribution,
        "generatedProfileImage": generated,
    })
}

/// `a || b` over row keys (first truthy value).
fn first_truthy(row: &Value, keys: &[&str]) -> Option<Value> {
    keys.iter().filter_map(|k| row.get(*k)).find(|v| js::truthy(Some(v))).cloned()
}

fn num(v: Option<&Value>) -> f64 {
    if js::truthy(v) { js::number(v) } else { 0.0 }
}

fn summary_artist(row: &Value) -> Value {
    let display = artist_display::display_name_for_artist(row.get("normalized_artist"), row.get("profile_display_name"), first_truthy(row, &["artist", "illustrator"]).as_ref());
    let or3 = |a: &str, b: &str, c: &str| [a.to_owned(), b.to_owned(), c.to_owned()].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
    let count = if js::truthy(row.get("artist_card_count")) { num(row.get("artist_card_count")) } else { num(row.get("visible_card_count")) };
    json!({
        "name": or3(&display, &s(row, "artist"), &s(row, "illustrator")),
        "illustrator": or3(&display, &s(row, "illustrator"), &s(row, "artist")),
        "normalizedArtist": s(row, "normalized_artist"),
        "slug": s(row, "artist_slug"),
        "cardCount": pg::js_number(count),
        "imageUrl": leftover_artist_image(&s(row, "image_url")),
        "coverName": s(row, "cover_name"),
        "artShade": s(row, "art_shade"),
        "profileImageUrl": same_origin_artist_profile_image_url(&s(row, "profile_image_url")),
    })
}

fn usable(artist: &Value) -> bool {
    !s(artist, "name").is_empty() && !s(artist, "slug").is_empty()
}

async fn artist_summaries(state: &RouteState, limit_raw: Option<&str>) -> Result<Vec<Value>, sqlx::Error> {
    let leftover = leftover_image_sql();
    let sql = format!(
        "
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
          artist.artist, artist.illustrator, artist.normalized_artist,
          {} as artist_slug,
          artist.artist_card_count, versions.blueprint_id, versions.ct_id, versions.name, versions.projected_at,
          {leftover} as image_url,
          shades.shade as art_shade,
          {} as cover_tier,
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
          and {leftover} is not null
          and {leftover} !~* '/previews/|/preview_'
      ),
      picked as (
        select distinct on (artist_cards.normalized_artist)
          artist_cards.artist, artist_cards.illustrator, artist_cards.normalized_artist, artist_cards.artist_slug,
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
    ",
        slug_sql("artist.normalized_artist"),
        cover_tier_sql()
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &[Bind::Int(util::js_limit(limit_raw, 1000, 5000))]).await?;
    let mut artists: Vec<Value> = rows.iter().map(summary_artist).filter(usable).collect();
    artists.sort_by(|a, b| {
        js::number(b.get("cardCount"))
            .partial_cmp(&js::number(a.get("cardCount")))
            .unwrap_or(Ordering::Equal)
            .then_with(|| s(a, "name").to_lowercase().cmp(&s(b, "name").to_lowercase()))
    });
    Ok(artists)
}

const IDENTITY_COLUMNS: &str = "        artist.artist,
        artist.illustrator,
        artist.normalized_artist,
        artist.artist_card_count,
        count(*) over ()::integer as total_artist_card_count,
        __SLUG__ as artist_slug,
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
";

async fn artist_identity_row(state: &RouteState, slugs: &[String], names: &[String]) -> Result<Option<Value>, sqlx::Error> {
    let (where_clause, bind) = if !slugs.is_empty() {
        (format!("{} = any($1::text[])", slug_sql("artist.normalized_artist")), Bind::TextArray(slugs.to_vec()))
    } else if !names.is_empty() {
        ("lower(artist.normalized_artist) = any($1::text[])".to_owned(), Bind::TextArray(names.to_vec()))
    } else {
        return Ok(None);
    };
    let sql = format!(
        "
      select
        artist.normalized_artist,
        {} as artist_slug,
        artist.artist, artist.illustrator, artist.artist_card_count,
        profiles.display_name as profile_display_name, profiles.summary as profile_summary, profiles.bio as profile_bio,
        profiles.profile_image_url, profiles.profile_image_cdn_url, profiles.profile_image_object_key,
        profiles.pocketmonsters_url as profile_pocketmonsters_url, profiles.pocketmonsters_id as profile_pocketmonsters_id,
        profiles.bulbapedia_url as profile_bulbapedia_url, profiles.bulbapedia_title as profile_bulbapedia_title,
        profiles.source_name as profile_source_name, profiles.source_url as profile_source_url,
        profiles.source_attribution as profile_source_attribution
      from public.marketplace_blueprint_artists artist
      left join public.marketplace_artist_profiles profiles
        on profiles.normalized_artist = artist.normalized_artist
      where {where_clause}
      order by artist.artist_card_count desc nulls last
      limit 1
    ",
        slug_sql("artist.normalized_artist")
    );
    Ok(pg::pool_rows(state.api.read(), &sql, &[bind]).await?.into_iter().next())
}

/// Header total for an artist desk. The stored `artist_card_count` belongs to
/// one spelling of the artist, while the rows union every slug alias, so a
/// complete list (fewer rows than the limit) is the true total: 5ban showed
/// "of 5097" over 5,175 rows. A truncated list keeps the larger of the two.
fn desk_card_count(stored: Option<f64>, rows: usize, limit: i64) -> f64 {
    let rows_f = rows as f64;
    if (rows as i64) < limit {
        return rows_f;
    }
    stored.map_or(rows_f, |count| count.max(rows_f))
}

async fn artist_cards_for_slug(state: &RouteState, artist_slug: Option<&str>, artist: Option<&str>, limit_raw: Option<&str>, tiles: bool) -> Result<Value, sqlx::Error> {
    let slugs = artist_display::slug_aliases_for_artist_slug(artist_slug.map(|v| Value::String(v.to_owned())).as_ref());
    let names = artist_display::lookup_aliases_for_artist_name(artist.map(|v| Value::String(v.to_owned())).as_ref());
    let mut where_clause = String::from("where coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url) is not null");
    let mut binds: Vec<Bind> = Vec::new();
    if !slugs.is_empty() {
        binds.push(Bind::TextArray(slugs.clone()));
        where_clause += &format!(" and {} = any($1::text[])", slug_sql("artist.normalized_artist"));
    } else if !names.is_empty() {
        binds.push(Bind::TextArray(names.clone()));
        where_clause += " and lower(artist.normalized_artist) = any($1::text[])";
    } else {
        return Ok(json!({ "artist": null, "cards": [] }));
    }
    // No cap below a whole artist: the list builder stores every card (5ban: 5,175).
    let limit = util::js_limit(limit_raw, 240, 20_000);
    binds.push(Bind::Int(limit));
    let limit_placeholder = format!("${}", binds.len());
    let number_sql = projected_expansion_number_sql();
    let number_int_sql = projected_expansion_number_int_sql(&number_sql);
    let rarity_sql = card_rarity::projected_rarity_sql_default("candidates.rarity", &number_sql);
    let identity_columns = if tiles { String::new() } else { IDENTITY_COLUMNS.replace("__SLUG__", &slug_sql("artist.normalized_artist")) };
    let profile_join = if tiles {
        ""
    } else {
        "      left join public.marketplace_artist_profiles profiles
        on profiles.normalized_artist = artist.normalized_artist
"
    };
    let image_column = if tiles {
        "        coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url, '') as image_url,"
    } else {
        "        coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url, '') as image_url,
        coalesce(versions.homepage_image_url, versions.preview_image_url, versions.cdn_image_url, versions.image_url, '') as cdn_image_url,
        versions.preview_image_url,
        versions.homepage_image_url,"
    };
    let sql = format!(
        "
      select
        versions.card_id,
        versions.name,
        versions.expansion_name,
        {number_sql} as expansion_number,
        {number_int_sql} as expansion_number_int,
        versions.product_variant,
        versions.blueprint_id,
{image_column}
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
{identity_columns}        {rarity_sql} as rarity,
        candidates.card_type,
        versions.projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        expansions.nationality
      from public.marketplace_card_versions versions
      join public.marketplace_blueprint_artists artist
        on artist.blueprint_id = versions.blueprint_id
      left join public.marketplace_leftover_art_shades shades
        on shades.ct_id = versions.ct_id
{profile_join}      left join public.marketplace_search_candidates candidates
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
      {where_clause}
      order by
        candidates.pokedex_sort asc nulls last,
        candidates.version asc nulls last,
        candidates.expansion_sort asc nulls last,
        candidates.collector_sort asc nulls last,
        {} asc,
        versions.card_id asc
      limit {limit_placeholder}
    ",
        normal_collector_sql(&number_sql)
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &binds).await?;
    let identity = if tiles { artist_identity_row(state, &slugs, &names).await? } else { rows.first().cloned() };
    let (artist_json, profile) = match identity.as_ref() {
        Some(first) => {
            let stored = [first.get("artist_card_count"), first.get("total_artist_card_count")]
                .into_iter()
                .find(|v| js::truthy(*v))
                .map(|v| js::number(v));
            let count = desk_card_count(stored, rows.len(), limit);
            let slug = s(first, "artist_slug");
            (
                json!({
                    "name": artist_display::display_name_for_artist(first.get("normalized_artist"), first.get("profile_display_name"), first_truthy(first, &["artist", "illustrator"]).as_ref()),
                    "illustrator": artist_display::display_name_for_artist(first.get("normalized_artist"), first.get("profile_display_name"), first_truthy(first, &["illustrator", "artist"]).as_ref()),
                    "normalizedArtist": s(first, "normalized_artist"),
                    "slug": if slug.is_empty() { slugs.first().cloned().unwrap_or_default() } else { slug },
                    "cardCount": pg::js_number(count),
                }),
                artist_profile_from_row(first),
            )
        }
        None => (Value::Null, Value::Null),
    };
    let cards: Vec<Value> = rows
        .iter()
        .map(|row| if tiles { row.clone() } else { artist_display::apply_artist_display_name_to_row(row) })
        .map(|row| card_emoji::with_card_emoji_fields(&row))
        .collect();
    let cards = react_sql::overlay_cheapest_on_rows(state.api.read(), true, &cards).await;
    Ok(json!({ "artist": artist_json, "profile": profile, "cards": cards }))
}

pub async fn handler(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    // Opt-in compact encoding; the default representation is unchanged.
    let wanted = util::wanted(&headers, &q);
    if q.search_param("summaries") == Some("1") {
        let limit_raw = q.search_param("limit");
        let projected = artist_summary::read_artist_summary(state.api.read(), util::js_limit(limit_raw, 240, 5000)).await;
        let artists = match projected {
            Ok(Some(rows)) => Ok(rows.iter().map(summary_artist).filter(usable).collect::<Vec<_>>()),
            Ok(None) => artist_summaries(&state, limit_raw).await,
            Err(error) => Err(error),
        };
        return match artists {
            Ok(artists) => util::json_cache_c1(wanted, StatusCode::OK, json!({ "artists": artists }), "public, max-age=60, s-maxage=3600"),
            Err(error) => util::db_error("marketplace-artist-cards", &error, "Marketplace artist cards failed."),
        };
    }
    let slug = util::first_of(&q, &["artistSlug", "slug"]);
    match artist_cards_for_slug(&state, slug, q.search_param("artist"), q.search_param("limit"), q.search_param("tiles") == Some("1")).await {
        Ok(payload) => util::json_cache_c1(wanted, StatusCode::OK, payload, "public, max-age=20, s-maxage=300"),
        Err(error) => util::db_error("marketplace-artist-cards", &error, "Marketplace artist cards failed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desk_card_count_trusts_a_complete_list() {
        assert_eq!(desk_card_count(Some(5097.0), 5175, 20_000), 5175.0);
        assert_eq!(desk_card_count(Some(900.0), 240, 240), 900.0);
        assert_eq!(desk_card_count(Some(100.0), 240, 240), 240.0);
        assert_eq!(desk_card_count(None, 12, 240), 12.0);
    }

    #[test]
    fn profile_urls() {
        assert_eq!(same_origin_artist_profile_image_url("https://cdn.pokoin.com/artist-profiles/ken.webp?x=1"), "https://pokoin.com/card-images/artist-profiles/ken.webp");
        assert_eq!(same_origin_artist_profile_image_url("https://x.example/a.png"), "https://x.example/a.png");
        let generated = json!({"source": "card_art_fallback", "generatedAt": "2026-10-01 10:00"});
        assert_eq!(generated_profile_image_versioned_url("https://pokoin.com/a.webp?v=1", &generated), "https://pokoin.com/a.webp?v=2026-10-01+10%3A00");
        assert_eq!(leftover_artist_image("https://cdn/previews/a.webp"), "");
    }
}
