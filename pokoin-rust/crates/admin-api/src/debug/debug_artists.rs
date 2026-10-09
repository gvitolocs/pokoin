//! Port of `api/marketplace-debug-artists.js` — artist enrichment debug:
//! next unresolved candidate, per-blueprint artist options, manual artist
//! selection, product/single reclassification (transactional) and skip votes.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;
use unicode_normalization::UnicodeNormalization;

use pokoin_api_common::{http, RouteState};

use super::{
    clean_blueprint_id_value, clean_text_value, db_error, iso_millis, json_object, request_query,
    truncate_utf16, value_get, DebugUser, HandlerError,
};

const MANUAL_ARTIST_SOURCE: &str = "manual_debug";
const MANUAL_PRODUCT_SOURCE: &str = "manual_debug_product";

/// `normalizeArtistKey(value)`.
pub(crate) fn normalize_artist_key(value: &Value) -> String {
    let base = clean_text_value(value, 180);
    let stripped: String = base
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect();
    stripped
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `cleanProductType(value)`.
pub(crate) fn clean_product_type(value: &Value) -> String {
    let text = clean_text_value(value, 80).to_lowercase();
    let mut out = String::new();
    let mut last_was_separator = false;
    for ch in text.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' {
            out.push(ch);
            last_was_separator = false;
        } else if !last_was_separator {
            out.push('_');
            last_was_separator = true;
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() || trimmed == "card" {
        "sealed_product".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `missingReason(row)`.
pub(crate) fn missing_reason(row: &Value) -> &'static str {
    let current_artist = value_get(row, "currentArtist").as_str().unwrap_or("");
    if current_artist.is_empty() {
        return "missing_artist";
    }
    let confidence = value_get(row, "currentConfidence")
        .as_f64()
        .or_else(|| super::js_number_of(value_get(row, "currentConfidence")))
        .unwrap_or(0.0);
    if confidence < 0.92 {
        return "low_confidence_artist";
    }
    "artist_needs_review"
}

/// `userLabel(user)`.
pub(crate) fn user_label(user: &DebugUser) -> String {
    let label = if !user.email.is_empty() {
        user.email.clone()
    } else if !user.username.is_empty() {
        user.username.clone()
    } else if !user.uid.is_empty() {
        user.uid.clone()
    } else {
        "debug user".to_owned()
    };
    clean_text_value(&Value::String(label), 240)
}

/// `ensureClassificationOverrideTable()` — the Node handler runs these guards
/// through `marketplaceQuery` (or the read-pool transaction client).
const OVERRIDE_TABLE_SQL: &str = r#"
    create table if not exists public.marketplace_blueprint_classification_overrides (
      blueprint_id bigint primary key references public.cardtrader_pokemon_blueprints(id) on delete cascade,
      item_kind text not null default 'single' check (item_kind in ('single', 'product')),
      product_type text not null default 'card',
      source text not null default '',
      reason text not null default '',
      debug_uid text not null default '',
      debug_email text not null default '',
      debug_username text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  "#;

const OVERRIDE_TABLE_INDEX_SQL: &str = r#"
    create index if not exists marketplace_blueprint_classification_overrides_source_idx
      on public.marketplace_blueprint_classification_overrides (source, updated_at desc)
  "#;

const SKIP_TABLE_SQL: &str = r#"
    create table if not exists public.marketplace_artist_debug_skips (
      id bigserial primary key,
      blueprint_id bigint not null references public.cardtrader_pokemon_blueprints(id) on delete cascade,
      debug_uid text not null default '',
      debug_email text not null default '',
      debug_username text not null default '',
      reason text not null default '',
      skipped_at timestamptz not null default now()
    )
  "#;

const SKIP_TABLE_INDEX_SQL: &str = r#"
    create index if not exists marketplace_artist_debug_skips_recent_idx
      on public.marketplace_artist_debug_skips (blueprint_id, debug_uid, debug_email, skipped_at desc)
  "#;

async fn ensure_classification_override_table(state: &RouteState) -> Result<(), sqlx::Error> {
    sqlx::query(OVERRIDE_TABLE_SQL)
        .execute(state.api.read())
        .await?;
    sqlx::query(OVERRIDE_TABLE_INDEX_SQL)
        .execute(state.api.read())
        .await?;
    Ok(())
}

async fn ensure_artist_debug_skip_table(state: &RouteState) -> Result<(), sqlx::Error> {
    sqlx::query(SKIP_TABLE_SQL)
        .execute(state.api.read())
        .await?;
    sqlx::query(SKIP_TABLE_INDEX_SQL)
        .execute(state.api.read())
        .await?;
    Ok(())
}

/// `fetchNextArtistCandidate(user)` main query (verbatim).
const NEXT_CANDIDATE_SQL: &str = r#"
    with unresolved as (
      select
        c.card_id,
        c.name,
        coalesce(nullif(c.source_name, ''), c.name) as source_name,
        coalesce(nullif(c.display_name, ''), c.name) as display_name,
        coalesce(nullif(c.canonical_name, ''), c.name) as canonical_name,
        c.set_name,
        c.card_number,
        c.product_variant,
        c.rarity,
        c.card_type,
        coalesce(o.item_kind, c.item_kind, 'single') as item_kind,
        coalesce(o.product_type, c.product_type, 'card') as product_type,
        c.trainer_name,
        coalesce(
          nullif(c.cdn_image_url, ''),
          nullif(b.cdn_image_url, ''),
          nullif(c.image_url, ''),
          nullif(b.image_url, ''),
          nullif(c.preview_image_url, ''),
          nullif(b.preview_image_url, ''),
          nullif(c.homepage_image_url, ''),
          nullif(b.homepage_image_url, ''),
          ''
        ) as image_url,
        coalesce(
          nullif(c.preview_image_url, ''),
          nullif(b.preview_image_url, ''),
          nullif(c.homepage_image_url, ''),
          nullif(b.homepage_image_url, ''),
          nullif(c.cdn_image_url, ''),
          nullif(b.cdn_image_url, ''),
          nullif(c.image_url, ''),
          nullif(b.image_url, ''),
          ''
        ) as preview_image_url,
        artist.artist as current_artist,
        artist.normalized_artist as current_normalized_artist,
        artist.confidence as current_confidence,
        artist.source as current_artist_source,
        artist.match_reason as current_match_reason,
        b.imported_at
      from public.marketplace_search_candidates c
      join public.cardtrader_pokemon_blueprints b on b.id = c.card_id
      left join public.marketplace_blueprint_artists artist
        on artist.blueprint_id = c.card_id
      left join public.marketplace_blueprint_classification_overrides o
        on o.blueprint_id = c.card_id
      where coalesce(o.item_kind, c.item_kind, 'single') <> 'product'
        and coalesce(o.product_type, c.product_type, 'card') = 'card'
        and coalesce(nullif(c.canonical_name, ''), c.name, '') <> ''
        and coalesce(c.cdn_image_url, b.cdn_image_url, c.image_url, b.image_url, c.preview_image_url, b.preview_image_url) is not null
        and not exists (
          select 1
          from public.marketplace_artist_debug_skips skips
          where skips.blueprint_id = c.card_id
            and skips.skipped_at >= now() - interval '12 hours'
            and (
              nullif(skips.debug_uid, '') = nullif($1::text, '')
              or nullif(skips.debug_email, '') = nullif($2::text, '')
            )
        )
        and (
          artist.blueprint_id is null
          or coalesce(artist.artist, '') = ''
          or artist.confidence < 0.92
        )
    ),
    with_options as (
      select
        unresolved.*,
        (
          select count(distinct existing.normalized_artist)::integer
          from public.marketplace_blueprint_artists existing
          join public.marketplace_search_candidates existing_card
            on existing_card.card_id = existing.blueprint_id
          where existing.blueprint_id <> unresolved.card_id
            and existing.normalized_artist <> ''
            and coalesce(nullif(existing_card.canonical_name, ''), existing_card.name) = unresolved.canonical_name
            and coalesce(existing_card.item_kind, 'single') <> 'product'
            and coalesce(existing_card.product_type, 'card') = 'card'
        ) as artist_option_count
      from unresolved
    )
    select *
    from with_options
    where artist_option_count > 0
    order by
      case when current_artist is null or current_artist = '' then 0 else 1 end,
      artist_option_count desc,
      imported_at desc nulls last,
      random()
    limit 1
"#;

/// `artistOptionsForIdentity(canonicalName, currentBlueprintId)` (verbatim).
const ARTIST_OPTIONS_SQL: &str = r#"
      with matches as (
        select
          artist.normalized_artist,
          artist.artist,
          artist.blueprint_id,
          cards.name,
          cards.set_name,
          cards.card_number,
          artist.confidence,
          row_number() over (
            partition by artist.normalized_artist
            order by artist.confidence desc, artist.matched_at desc nulls last, cards.card_id desc
          ) as example_rank
        from public.marketplace_blueprint_artists artist
        join public.marketplace_search_candidates cards
          on cards.card_id = artist.blueprint_id
        where artist.normalized_artist <> ''
          and artist.blueprint_id <> $2::bigint
          and coalesce(nullif(cards.canonical_name, ''), cards.name) = $1::text
          and coalesce(cards.item_kind, 'single') <> 'product'
          and coalesce(cards.product_type, 'card') = 'card'
      )
      select
        normalized_artist,
        (array_agg(artist order by confidence desc, blueprint_id desc))[1] as artist,
        count(distinct blueprint_id)::integer as known_count,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'blueprintId', blueprint_id::text,
              'name', name,
              'setName', set_name,
              'collectorNumber', card_number
            )
            order by confidence desc, blueprint_id desc
          ) filter (where example_rank <= 3),
          '[]'::jsonb
        ) as examples
      from matches
      group by normalized_artist
      order by known_count desc, artist asc
      limit 80
    "#;

/// `allArtistOptions({ limit = 1000 })` (verbatim).
const ALL_ARTIST_OPTIONS_SQL: &str = r#"
      with artists as (
        select
          normalized_artist,
          max(nullif(artist, '')) as artist,
          count(distinct blueprint_id)::integer as known_count
        from public.marketplace_blueprint_artists
        where normalized_artist <> ''
        group by normalized_artist
        union all
        select
          normalized_artist,
          max(nullif(display_name, '')) as artist,
          0 as known_count
        from public.marketplace_artist_profiles
        where normalized_artist <> ''
        group by normalized_artist
      ),
      merged as (
        select
          normalized_artist,
          (array_agg(artist order by known_count desc, artist asc))[1] as artist,
          sum(known_count)::integer as known_count
        from artists
        group by normalized_artist
      )
      select normalized_artist, artist, known_count
      from merged
      where coalesce(artist, '') <> ''
      order by artist asc
      limit $1::integer
    "#;

/// `artistOptionByNormalized(normalizedArtist)` (verbatim).
const ARTIST_BY_NORMALIZED_SQL: &str = r#"
      with artist_sources as (
        select
          normalized_artist,
          max(nullif(artist, '')) as artist,
          max(coalesce(artist_card_count, 0))::integer as artist_card_count,
          count(distinct blueprint_id)::integer as known_count
        from public.marketplace_blueprint_artists
        where normalized_artist = $1::text
        group by normalized_artist
        union all
        select
          normalized_artist,
          max(nullif(display_name, '')) as artist,
          0::integer as artist_card_count,
          0::integer as known_count
        from public.marketplace_artist_profiles
        where normalized_artist = $1::text
        group by normalized_artist
      ),
      merged as (
        select
          normalized_artist,
          (array_agg(artist order by known_count desc, artist_card_count desc, artist asc))[1] as artist,
          greatest(max(artist_card_count), sum(known_count))::integer as known_count
        from artist_sources
        where coalesce(artist, '') <> ''
        group by normalized_artist
      ),
      examples as (
        select
          artist.blueprint_id,
          cards.name,
          cards.set_name,
          cards.card_number,
          row_number() over (
            order by artist.confidence desc, artist.matched_at desc nulls last, artist.blueprint_id desc
          ) as example_rank
        from public.marketplace_blueprint_artists artist
        left join public.marketplace_search_candidates cards
          on cards.card_id = artist.blueprint_id
        where artist.normalized_artist = $1::text
      )
      select
        merged.normalized_artist,
        merged.artist,
        merged.known_count,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'blueprintId', blueprint_id::text,
                'name', coalesce(name, ''),
                'setName', coalesce(set_name, ''),
                'collectorNumber', coalesce(card_number, '')
              )
              order by example_rank
            )
            from examples
            where example_rank <= 3
          ),
          '[]'::jsonb
        ) as examples
      from merged
      limit 1
    "#;

const LOAD_CANDIDATE_SQL: &str = r#"
      select
        c.card_id,
        c.name,
        coalesce(nullif(c.canonical_name, ''), c.name) as canonical_name,
        c.set_name,
        c.card_number,
        coalesce(o.item_kind, c.item_kind, 'single') as item_kind,
        coalesce(o.product_type, c.product_type, 'card') as product_type
      from public.marketplace_search_candidates c
      left join public.marketplace_blueprint_classification_overrides o
        on o.blueprint_id = c.card_id
      where c.card_id = $1::bigint
      limit 1
    "#;

fn artist_option_from_row(row: &sqlx::postgres::PgRow) -> Value {
    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    let normalized = text("normalized_artist");
    let artist = text("artist");
    json_object(vec![
        ("normalizedArtist", Value::String(normalized.clone())),
        (
            "artist",
            Value::String(if artist.is_empty() {
                normalized
            } else {
                artist
            }),
        ),
        (
            "knownCount",
            json!(row
                .try_get::<Option<i32>, _>("known_count")
                .unwrap_or(None)
                .unwrap_or(0)),
        ),
        (
            "examples",
            row.try_get::<Option<Value>, _>("examples")
                .unwrap_or(None)
                .unwrap_or_else(|| json!([])),
        ),
    ])
}

async fn artist_options_for_identity(
    state: &RouteState,
    canonical_name: &str,
    current_blueprint_id: i64,
) -> Result<Vec<Value>, HandlerError> {
    let rows = sqlx::query(ARTIST_OPTIONS_SQL)
        .bind(canonical_name)
        .bind(current_blueprint_id)
        .fetch_all(state.api.read())
        .await
        .map_err(db_error)?;
    Ok(rows.iter().map(artist_option_from_row).collect())
}

async fn all_artist_options(state: &RouteState, limit: i64) -> Result<Vec<Value>, HandlerError> {
    let limit = limit.clamp(1, 5000);
    let rows = sqlx::query(ALL_ARTIST_OPTIONS_SQL)
        .bind(limit)
        .fetch_all(state.api.read())
        .await
        .map_err(db_error)?;
    Ok(rows
        .iter()
        .map(|row| {
            let mut option = artist_option_from_row(row);
            if let Value::Object(map) = &mut option {
                map.insert("examples".to_owned(), json!([]));
            }
            option
        })
        .collect())
}

async fn artist_option_by_normalized(
    state: &RouteState,
    normalized: &str,
) -> Result<Option<Value>, HandlerError> {
    let key = normalize_artist_key(&Value::String(normalized.to_owned()));
    if key.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query(ARTIST_BY_NORMALIZED_SQL)
        .bind(&key)
        .fetch_optional(state.api.read())
        .await
        .map_err(db_error)?;
    Ok(row.map(|row| artist_option_from_row(&row)))
}

/// `serializeCandidate(row, artists)`.
pub(crate) fn serialize_candidate(row: &Value, artists: Vec<Value>) -> Value {
    let text = |key: &str| -> String { value_get(row, key).as_str().unwrap_or("").to_owned() };
    let name = text("name");
    let image_url = text("image_url");
    let current_artist = text("currentArtist");
    let confidence = value_get(row, "currentConfidence").as_f64().unwrap_or(0.0);
    json_object(vec![
        ("blueprintId", Value::String(text("blueprintId"))),
        ("name", Value::String(name.clone())),
        ("sourceName", Value::String(text("sourceName"))),
        (
            "displayName",
            Value::String({
                let display = text("displayName");
                if display.is_empty() {
                    name.clone()
                } else {
                    display
                }
            }),
        ),
        (
            "canonicalName",
            Value::String({
                let canonical = text("canonicalName");
                if canonical.is_empty() {
                    name.clone()
                } else {
                    canonical
                }
            }),
        ),
        ("expansionName", Value::String(text("expansionName"))),
        ("collectorNumber", Value::String(text("collectorNumber"))),
        ("productVariant", Value::String(text("productVariant"))),
        ("rarity", Value::String(text("rarity"))),
        ("cardType", Value::String(text("cardType"))),
        (
            "itemKind",
            Value::String({
                let kind = text("itemKind");
                if kind.is_empty() {
                    "single".to_owned()
                } else {
                    kind
                }
            }),
        ),
        (
            "productType",
            Value::String({
                let product = text("productType");
                if product.is_empty() {
                    "card".to_owned()
                } else {
                    product
                }
            }),
        ),
        ("trainerName", Value::String(text("trainerName"))),
        ("imageUrl", Value::String(image_url.clone())),
        (
            "previewImageUrl",
            Value::String({
                let preview = text("previewImageUrl");
                if preview.is_empty() {
                    image_url
                } else {
                    preview
                }
            }),
        ),
        ("currentArtist", Value::String(current_artist)),
        (
            "currentNormalizedArtist",
            Value::String(text("currentNormalizedArtist")),
        ),
        (
            "currentArtistSource",
            Value::String(text("currentArtistSource")),
        ),
        ("currentConfidence", json!(confidence)),
        (
            "currentMatchReason",
            Value::String(text("currentMatchReason")),
        ),
        (
            "missingReason",
            Value::String(missing_reason(row).to_owned()),
        ),
        ("artists", Value::Array(artists)),
    ])
}

async fn fetch_next_artist_candidate(
    state: &RouteState,
    user: &DebugUser,
) -> Result<Value, HandlerError> {
    ensure_classification_override_table(state)
        .await
        .map_err(db_error)?;
    ensure_artist_debug_skip_table(state)
        .await
        .map_err(db_error)?;
    let row = sqlx::query(NEXT_CANDIDATE_SQL)
        .bind(truncate_utf16(user.uid.trim(), 160))
        .bind(truncate_utf16(user.email.trim(), 240))
        .fetch_optional(state.api.read())
        .await
        .map_err(db_error)?;
    let Some(row) = row else {
        return Ok(json!({
            "candidate": Value::Null,
            "reason": "no_unresolved_artist_candidates_with_known_same_pokemon_artists",
        }));
    };

    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    let canonical_name = text("canonical_name");
    let card_id: i64 = row.try_get("card_id").unwrap_or(0);
    let confidence: Option<sqlx::types::BigDecimal> =
        row.try_get("current_confidence").unwrap_or(None);

    // Shape the DB row into the serializeCandidate input keys.
    let shaped = json!({
        "blueprintId": card_id.to_string(),
        "name": text("name"),
        "sourceName": text("source_name"),
        "displayName": text("display_name"),
        "canonicalName": canonical_name.clone(),
        "expansionName": text("set_name"),
        "collectorNumber": text("card_number"),
        "productVariant": text("product_variant"),
        "rarity": text("rarity"),
        "cardType": text("card_type"),
        "itemKind": text("item_kind"),
        "productType": text("product_type"),
        "trainerName": text("trainer_name"),
        "imageUrl": text("image_url"),
        "previewImageUrl": text("preview_image_url"),
        "currentArtist": text("current_artist"),
        "currentNormalizedArtist": text("current_normalized_artist"),
        "currentArtistSource": text("current_artist_source"),
        "currentConfidence": confidence
            .and_then(|value| value.to_string().parse::<f64>().ok())
            .unwrap_or(0.0),
        "currentMatchReason": text("current_match_reason"),
    });
    let artists = artist_options_for_identity(state, &canonical_name, card_id).await?;
    Ok(json!({
        "candidate": serialize_candidate(&shaped, artists),
        "reason": "",
    }))
}

async fn load_candidate_for_manual_action(
    state: &RouteState,
    blueprint_id: i64,
) -> Result<Value, HandlerError> {
    ensure_classification_override_table(state)
        .await
        .map_err(db_error)?;
    let row = sqlx::query(LOAD_CANDIDATE_SQL)
        .bind(blueprint_id)
        .fetch_optional(state.api.read())
        .await
        .map_err(db_error)?;
    let Some(row) = row else {
        return Err(HandlerError::new(
            StatusCode::NOT_FOUND,
            "Blueprint was not found in marketplace search candidates.",
        ));
    };
    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    Ok(json!({
        "card_id": row.try_get::<i64, _>("card_id").unwrap_or(0),
        "name": text("name"),
        "canonical_name": text("canonical_name"),
        "set_name": text("set_name"),
        "card_number": text("card_number"),
        "item_kind": text("item_kind"),
        "product_type": text("product_type"),
    }))
}

async fn fetch_artist_options_for_blueprint(
    state: &RouteState,
    blueprint_id: i64,
) -> Result<Value, HandlerError> {
    let candidate = load_candidate_for_manual_action(state, blueprint_id).await?;
    let existing = sqlx::query(
        r#"
      select artist, normalized_artist, confidence, source, match_reason
      from public.marketplace_blueprint_artists
      where blueprint_id = $1::bigint
      limit 1
    "#,
    )
    .bind(blueprint_id)
    .fetch_optional(state.api.read())
    .await
    .map_err(db_error)?;
    let text = |row: Option<&sqlx::postgres::PgRow>, column: &str| -> String {
        row.and_then(|row| row.try_get::<Option<String>, _>(column).unwrap_or_default())
            .unwrap_or_default()
    };
    let row_ref = existing.as_ref();
    let confidence = row_ref
        .and_then(|row| {
            row.try_get::<Option<sqlx::types::BigDecimal>, _>("confidence")
                .unwrap_or(None)
        })
        .and_then(|value| value.to_string().parse::<f64>().ok())
        .unwrap_or(0.0);
    let shaped = json!({
        "blueprintId": blueprint_id.to_string(),
        "name": value_get(&candidate, "name").as_str().unwrap_or(""),
        "sourceName": "",
        "displayName": value_get(&candidate, "name").as_str().unwrap_or(""),
        "canonicalName": value_get(&candidate, "canonical_name").as_str().unwrap_or(""),
        "expansionName": value_get(&candidate, "set_name").as_str().unwrap_or(""),
        "collectorNumber": value_get(&candidate, "card_number").as_str().unwrap_or(""),
        "productVariant": "",
        "rarity": "",
        "cardType": "",
        "itemKind": value_get(&candidate, "item_kind").as_str().unwrap_or("single"),
        "productType": value_get(&candidate, "product_type").as_str().unwrap_or("card"),
        "trainerName": "",
        "imageUrl": "",
        "previewImageUrl": "",
        "currentArtist": text(row_ref, "artist"),
        "currentNormalizedArtist": text(row_ref, "normalized_artist"),
        "currentArtistSource": text(row_ref, "source"),
        "currentConfidence": confidence,
        "currentMatchReason": text(row_ref, "match_reason"),
    });
    let options = all_artist_options(state, 1000).await?;
    Ok(json!({
        "candidate": serialize_candidate(&shaped, options),
        "reason": "",
    }))
}

/// `saveManualArtist(body, user)`.
async fn save_manual_artist(
    state: &RouteState,
    body: &Value,
    user: &DebugUser,
) -> Result<Value, HandlerError> {
    let blueprint_id = clean_blueprint_id_value(value_get(body, "blueprintId"));
    let normalized_artist = normalize_artist_key(value_get(body, "normalizedArtist"));
    if blueprint_id == 0 || normalized_artist.is_empty() {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Blueprint and artist are required.",
        ));
    }
    let candidate = load_candidate_for_manual_action(state, blueprint_id).await?;
    let item_kind = value_get(&candidate, "item_kind")
        .as_str()
        .unwrap_or("single");
    let product_type = value_get(&candidate, "product_type")
        .as_str()
        .unwrap_or("card");
    if item_kind == "product" || product_type != "card" {
        return Err(HandlerError::new(
            StatusCode::CONFLICT,
            "This blueprint is classified as a product; artist selection is disabled.",
        ));
    }

    let allow_any = value_get(body, "allowAnyArtist").as_bool() == Some(true);
    let canonical_name = value_get(&candidate, "canonical_name")
        .as_str()
        .unwrap_or("")
        .to_owned();
    let options: Vec<Value> = if allow_any {
        artist_option_by_normalized(state, &normalized_artist)
            .await?
            .into_iter()
            .collect()
    } else {
        artist_options_for_identity(state, &canonical_name, blueprint_id).await?
    };
    let selected = options
        .iter()
        .find(|option| {
            value_get(option, "normalizedArtist").as_str() == Some(normalized_artist.as_str())
        })
        .cloned();
    let Some(selected) = selected else {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Selected artist is not known for this Pokemon identity.",
        ));
    };

    let artist = value_get(&selected, "artist")
        .as_str()
        .unwrap_or("")
        .to_owned();
    let source_card_id = value_get(&selected, "examples")
        .get(0)
        .and_then(|example| {
            value_get(example, "blueprintId")
                .as_str()
                .map(str::to_owned)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| blueprint_id.to_string());
    let match_reason = format!(
        "Manual debug curation by {}{}.",
        user_label(user),
        if allow_any {
            " from full artist list".to_owned()
        } else {
            format!(" using known {canonical_name} artists")
        }
    );
    let raw_metadata = json!({
        "debugUser": {
            "uid": truncate_utf16(user.uid.trim(), 160),
            "email": truncate_utf16(user.email.trim(), 240),
            "username": truncate_utf16(user.username.trim(), 120),
        },
        "candidate": {
            "blueprintId": blueprint_id.to_string(),
            "name": value_get(&candidate, "name").as_str().unwrap_or(""),
            "canonicalName": canonical_name,
            "setName": value_get(&candidate, "set_name").as_str().unwrap_or(""),
            "collectorNumber": value_get(&candidate, "card_number").as_str().unwrap_or(""),
        },
        "selectedExamples": value_get(&selected, "examples").clone(),
    });

    let row = sqlx::query(
        r#"
      insert into public.marketplace_blueprint_artists (
        blueprint_id,
        artist,
        illustrator,
        normalized_artist,
        source,
        source_card_id,
        source_url,
        confidence,
        match_reason,
        matched_at,
        raw_metadata,
        updated_at
      )
      values (
        $1::bigint,
        $2::text,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        '',
        0.99,
        $6::text,
        now(),
        $7::jsonb,
        now()
      )
      on conflict (blueprint_id)
      do update set
        artist = excluded.artist,
        illustrator = excluded.illustrator,
        normalized_artist = excluded.normalized_artist,
        source = excluded.source,
        source_card_id = excluded.source_card_id,
        source_url = excluded.source_url,
        confidence = excluded.confidence,
        match_reason = excluded.match_reason,
        matched_at = excluded.matched_at,
        raw_metadata = excluded.raw_metadata,
        updated_at = now()
      returning blueprint_id, artist, normalized_artist, confidence, source, match_reason, matched_at
    "#,
    )
    .bind(blueprint_id)
    .bind(&artist)
    .bind(&normalized_artist)
    .bind(MANUAL_ARTIST_SOURCE)
    .bind(&source_card_id)
    .bind(&match_reason)
    .bind(raw_metadata.to_string())
    .fetch_one(state.api.read())
    .await
    .map_err(db_error)?;

    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    let confidence: Option<sqlx::types::BigDecimal> = row.try_get("confidence").unwrap_or(None);
    let matched_at: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("matched_at").unwrap_or(None);
    Ok(json_object(vec![
        (
            "blueprint_id",
            Value::String(
                row.try_get::<i64, _>("blueprint_id")
                    .unwrap_or(0)
                    .to_string(),
            ),
        ),
        ("artist", Value::String(text("artist"))),
        (
            "normalized_artist",
            Value::String(text("normalized_artist")),
        ),
        (
            "confidence",
            json!(confidence
                .and_then(|value| value.to_string().parse::<f64>().ok())
                .unwrap_or(0.0)),
        ),
        ("source", Value::String(text("source"))),
        ("match_reason", Value::String(text("match_reason"))),
        ("matched_at", iso_millis(&matched_at)),
    ]))
}

/// Shared transaction body of `classifyBlueprintAsProduct` and
/// `classifyBlueprintAsSingleCard` — the Node code runs every statement on a
/// read-pool client (`getMarketplacePool().connect()`).
async fn classify_blueprint(
    state: &RouteState,
    body: &Value,
    user: &DebugUser,
    as_product: bool,
) -> Result<Value, HandlerError> {
    let blueprint_id = clean_blueprint_id_value(value_get(body, "blueprintId"));
    if blueprint_id == 0 {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Blueprint is required.",
        ));
    }
    let product_type = if as_product {
        clean_product_type(value_get(body, "productType"))
    } else {
        "card".to_owned()
    };

    let mut tx = state.api.read().begin().await.map_err(db_error)?;
    sqlx::query(OVERRIDE_TABLE_SQL)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query(OVERRIDE_TABLE_INDEX_SQL)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;

    let existing = sqlx::query(
        r#"
        select card_id, name
        from public.marketplace_search_candidates
        where card_id = $1::bigint
        limit 1
      "#,
    )
    .bind(blueprint_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    if existing.is_none() {
        return Err(HandlerError::new(
            StatusCode::NOT_FOUND,
            "Blueprint was not found in marketplace search candidates.",
        ));
    }

    let default_reason = if as_product {
        format!(
            "Classified as product from artist debug page by {}.",
            user_label(user)
        )
    } else {
        format!(
            "Classified as single card from detail debug button by {}.",
            user_label(user)
        )
    };
    let reason = {
        let raw = value_get(body, "reason");
        if raw.is_null() {
            truncate_utf16(default_reason.trim(), 500)
        } else {
            clean_text_value(raw, 500)
        }
    };

    if as_product {
        sqlx::query(
            r#"
        with input as (
          select
            $1::bigint as blueprint_id,
            $2::text as product_type,
            $3::text as source,
            $4::text as reason,
            $5::text as debug_uid,
            $6::text as debug_email,
            $7::text as debug_username
        )
        insert into public.marketplace_blueprint_classification_overrides (
          blueprint_id,
          item_kind,
          product_type,
          source,
          reason,
          debug_uid,
          debug_email,
          debug_username,
          updated_at
        )
        select
          blueprint_id,
          'product'::text,
          product_type,
          source,
          reason,
          debug_uid,
          debug_email,
          debug_username,
          now()
        from input
        on conflict (blueprint_id)
        do update set
          item_kind = excluded.item_kind,
          product_type = excluded.product_type,
          source = excluded.source,
          reason = excluded.reason,
          debug_uid = excluded.debug_uid,
          debug_email = excluded.debug_email,
          debug_username = excluded.debug_username,
          updated_at = now()
      "#,
        )
        .bind(blueprint_id)
        .bind(&product_type)
        .bind(MANUAL_PRODUCT_SOURCE)
        .bind(&reason)
        .bind(truncate_utf16(user.uid.trim(), 160))
        .bind(truncate_utf16(user.email.trim(), 240))
        .bind(truncate_utf16(user.username.trim(), 120))
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    } else {
        sqlx::query(
            r#"
        with input as (
          select
            $1::bigint as blueprint_id,
            $2::text as source,
            $3::text as reason,
            $4::text as debug_uid,
            $5::text as debug_email,
            $6::text as debug_username
        )
        insert into public.marketplace_blueprint_classification_overrides (
          blueprint_id,
          item_kind,
          product_type,
          source,
          reason,
          debug_uid,
          debug_email,
          debug_username,
          updated_at
        )
        select
          blueprint_id,
          'single'::text,
          'card'::text,
          source,
          reason,
          debug_uid,
          debug_email,
          debug_username,
          now()
        from input
        on conflict (blueprint_id)
        do update set
          item_kind = excluded.item_kind,
          product_type = excluded.product_type,
          source = excluded.source,
          reason = excluded.reason,
          debug_uid = excluded.debug_uid,
          debug_email = excluded.debug_email,
          debug_username = excluded.debug_username,
          updated_at = now()
      "#,
        )
        .bind(blueprint_id)
        .bind(MANUAL_PRODUCT_SOURCE)
        .bind(&reason)
        .bind(truncate_utf16(user.uid.trim(), 160))
        .bind(truncate_utf16(user.email.trim(), 240))
        .bind(truncate_utf16(user.username.trim(), 120))
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    }

    if as_product {
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id, $2::text as product_type
        )
        update public.marketplace_cards as cards
        set item_kind = 'product',
          product_type = input.product_type,
          projected_at = now()
        from input
        where cards.card_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .bind(&product_type)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id, $2::text as product_type
        )
        update public.marketplace_search_candidates as candidates
        set item_kind = 'product',
          product_type = input.product_type,
          search_text = lower(concat_ws(' ', canonical_name, display_name, source_name, set_name, card_number, product_variant, rarity, card_type, 'product', input.product_type, trainer_name)),
          projected_at = now()
        from input
        where candidates.card_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .bind(&product_type)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    } else {
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id
        )
        update public.marketplace_cards as cards
        set item_kind = 'single',
          product_type = 'card',
          projected_at = now()
        from input
        where cards.card_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id
        )
        update public.marketplace_search_candidates as candidates
        set item_kind = 'single',
          product_type = 'card',
          search_text = lower(concat_ws(' ', canonical_name, display_name, source_name, set_name, card_number, rarity, card_type, trainer_name)),
          projected_at = now()
        from input
        where candidates.card_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    }

    if as_product {
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id, $2::text as product_type
        )
        update public.marketplace_card_versions as versions
        set product_type = input.product_type,
          projected_at = now()
        from input
        where versions.card_id = input.blueprint_id or versions.blueprint_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .bind(&product_type)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id, $2::text as product_type
        )
        update public.marketplace_card_urls as urls
        set item_kind = 'product',
          product_type = input.product_type,
          updated_at = now()
        from input
        where urls.card_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .bind(&product_type)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    } else {
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id
        )
        update public.marketplace_card_versions as versions
        set product_type = 'card',
          projected_at = now()
        from input
        where versions.card_id = input.blueprint_id or versions.blueprint_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        sqlx::query(
            r#"
        with input as (
          select $1::bigint as blueprint_id
        )
        update public.marketplace_card_urls as urls
        set item_kind = 'single',
          product_type = 'card',
          updated_at = now()
        from input
        where urls.card_id = input.blueprint_id
      "#,
        )
        .bind(blueprint_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    }

    tx.commit().await.map_err(db_error)?;
    Ok(json!({
        "blueprintId": blueprint_id.to_string(),
        "itemKind": if as_product { "product" } else { "single" },
        "productType": product_type,
        "source": MANUAL_PRODUCT_SOURCE,
    }))
}

/// `skipCandidate(body, user)`.
async fn skip_candidate(
    state: &RouteState,
    body: &Value,
    user: &DebugUser,
) -> Result<Value, HandlerError> {
    let blueprint_id = clean_blueprint_id_value(value_get(body, "blueprintId"));
    if blueprint_id == 0 {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Blueprint is required.",
        ));
    }
    ensure_artist_debug_skip_table(state)
        .await
        .map_err(db_error)?;
    let reason = {
        let raw = value_get(body, "reason");
        if raw.is_null() {
            truncate_utf16(
                format!("Skipped from artist debug page by {}.", user_label(user)).trim(),
                500,
            )
        } else {
            clean_text_value(raw, 500)
        }
    };
    sqlx::query(
        r#"
      insert into public.marketplace_artist_debug_skips (
        blueprint_id,
        debug_uid,
        debug_email,
        debug_username,
        reason,
        skipped_at
      )
      values ($1::bigint, $2::text, $3::text, $4::text, $5::text, now())
    "#,
    )
    .bind(blueprint_id)
    .bind(truncate_utf16(user.uid.trim(), 160))
    .bind(truncate_utf16(user.email.trim(), 240))
    .bind(truncate_utf16(user.username.trim(), 120))
    .bind(&reason)
    .execute(state.api.read())
    .await
    .map_err(db_error)?;
    Ok(json!({
        "blueprintId": blueprint_id.to_string(),
        "skipped": true,
    }))
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if method != Method::GET && method != Method::POST {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET, POST")],
        );
    }

    let user = match state.require_debug_admin(&headers).await {
        Ok(claims) => DebugUser::from_claims(&claims),
        Err(error) => return error,
    };

    if method == Method::GET {
        let query = request_query(&uri);
        let blueprint_id = clean_blueprint_id_value(&Value::String(query.text("blueprintId")));
        let payload = if blueprint_id > 0 {
            fetch_artist_options_for_blueprint(&state, blueprint_id).await
        } else {
            fetch_next_artist_candidate(&state, &user).await
        };
        return match payload {
            Ok(mut payload) => {
                if let Value::Object(map) = &mut payload {
                    map.insert("generatedAt".to_owned(), Value::String(super::now_iso()));
                    map.insert("user".to_owned(), user.to_json());
                }
                http::json_with(
                    StatusCode::OK,
                    payload,
                    &[("cache-control", "private, no-store")],
                )
            }
            Err(error) => error.into_response_with(&[]),
        };
    }

    let parsed = match http::parse_body(&headers, &body) {
        Ok(parsed) => parsed.json(),
        Err(error) => return error,
    };
    let action = clean_text_value(value_get(&parsed, "action"), 40);
    let result = match action.as_str() {
        "select_artist" => save_manual_artist(&state, &parsed, &user)
            .await
            .map(|saved| json!({ "ok": true, "saved": saved })),
        "classify_product" => classify_blueprint(&state, &parsed, &user, true)
            .await
            .map(|classified| json!({ "ok": true, "classified": classified })),
        "classify_single" => classify_blueprint(&state, &parsed, &user, false)
            .await
            .map(|classified| json!({ "ok": true, "classified": classified })),
        "skip" => skip_candidate(&state, &parsed, &user)
            .await
            .map(|skipped| json!({ "ok": true, "skipped": skipped })),
        _ => Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Unsupported artist debug action.",
        )),
    };
    match result {
        Ok(body) => http::json(StatusCode::OK, body),
        Err(error) => error.into_response_with(&[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_artist_key_folds_and_collapses() {
        assert_eq!(
            normalize_artist_key(&json!("  Atsuko   Nishida ")),
            "atsuko nishida"
        );
        assert_eq!(
            normalize_artist_key(&json!("Mitsuhiro Arita")),
            "mitsuhiro arita"
        );
        assert_eq!(normalize_artist_key(&json!("Škoda")), "skoda");
        assert_eq!(normalize_artist_key(&json!(null)), "");
    }

    #[test]
    fn clean_product_type_defaults() {
        assert_eq!(clean_product_type(&json!(null)), "sealed_product");
        assert_eq!(clean_product_type(&json!("card")), "sealed_product");
        assert_eq!(clean_product_type(&json!("Theme Deck")), "theme_deck");
        assert_eq!(clean_product_type(&json!("  booster-box ")), "booster_box");
    }

    #[test]
    fn missing_reason_thresholds() {
        assert_eq!(
            missing_reason(&json!({"currentArtist": "", "currentConfidence": 0})),
            "missing_artist"
        );
        assert_eq!(
            missing_reason(&json!({"currentArtist": "Arita", "currentConfidence": 0.5})),
            "low_confidence_artist"
        );
        assert_eq!(
            missing_reason(&json!({"currentArtist": "Arita", "currentConfidence": 0.99})),
            "artist_needs_review"
        );
        assert_eq!(
            missing_reason(&json!({"currentArtist": "Arita", "currentConfidence": "0.92"})),
            "artist_needs_review"
        );
    }

    #[test]
    fn user_label_prefers_email() {
        let user = DebugUser {
            uid: "u1".to_owned(),
            email: "giuseppe@pokoin.com".to_owned(),
            username: "giuseppe".to_owned(),
        };
        assert_eq!(user_label(&user), "giuseppe@pokoin.com");
        let no_email = DebugUser {
            uid: "u1".to_owned(),
            email: String::new(),
            username: "giuseppe".to_owned(),
        };
        assert_eq!(user_label(&no_email), "giuseppe");
        let bare = DebugUser {
            uid: String::new(),
            email: String::new(),
            username: String::new(),
        };
        assert_eq!(user_label(&bare), "debug user");
    }

    #[test]
    fn serialize_candidate_shapes_fields() {
        let row = json!({
            "blueprintId": "123",
            "name": "Pikachu",
            "displayName": "",
            "canonicalName": "",
            "currentArtist": "",
            "currentConfidence": 0,
        });
        let value = serialize_candidate(&row, vec![json!({"normalizedArtist": "atsuko nishida"})]);
        assert_eq!(value["blueprintId"], "123");
        assert_eq!(value["displayName"], "Pikachu");
        assert_eq!(value["canonicalName"], "Pikachu");
        assert_eq!(value["itemKind"], "single");
        assert_eq!(value["productType"], "card");
        assert_eq!(value["missingReason"], "missing_artist");
        assert_eq!(value["artists"][0]["normalizedArtist"], "atsuko nishida");
    }
}
