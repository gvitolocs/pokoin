//! Public seller shop and seller settings (ship-from country, PKN policy,
//! Stripe Connect readiness).

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};
use sqlx::Row;

use super::{private_json, text_field};
use crate::domain::country::{normalize_country, ship_from_country_from_request};
use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState};
use crate::store;
use pokoin_api_common::compact::{encode as compact_encode, Wanted, C1_CONTENT_TYPE, C1_FORMAT_HEADER};
use pokoin_api_common::pg::{number_f64, number_i64};

const PAGE_DEFAULT: i64 = 60;
/// The columns a shop row is built from. The book reads exactly these: a
/// `select *` of ten thousand listings also carried comments, photos and
/// source metadata nobody shows in a shop.
const BOOK_COLUMNS: &str = "id, card_id, seller_country, marketplace_game, condition, language, \
     price_pkn, quantity_available, signed, reverse, first_edition, altered, foil_state, \
     variant_state, sealed, graded, shipping_available, card_name, card_image_url, set_name, \
     collector_number, status, created_at, updated_at";

fn clean_username(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('@')
        .to_lowercase()
        .chars()
        .take(64)
        .collect()
}

fn clean_limit(value: Option<&String>) -> i64 {
    match value.and_then(|value| value.parse::<f64>().ok()) {
        Some(number) if number.is_finite() => (number.trunc() as i64).clamp(1, 200),
        _ => PAGE_DEFAULT,
    }
}

fn clean_offset(value: Option<&String>) -> i64 {
    match value.and_then(|value| value.parse::<f64>().ok()) {
        Some(number) if number.is_finite() && number > 0.0 => {
            (number.trunc() as i64).min(50_000)
        }
        _ => 0,
    }
}

fn truthy_flag(value: Option<&String>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// `conditionSql`: Pokoin chips → stored short codes.
fn condition_codes(code: &str) -> Option<Vec<&'static str>> {
    let raw = code.trim().to_ascii_uppercase();
    let codes: &[&str] = match raw.as_str() {
        "NM" | "M" => &["NM", "M"],
        "SP" | "LP" => &["SP", "LP"],
        "MP" => &["MP"],
        "PL" | "HP" => &["PL", "HP"],
        "POOR" | "PO" | "D" | "DMG" => &["PO", "POOR", "D", "DMG"],
        _ => return None,
    };
    Some(codes.to_vec())
}

fn sort_sql(sort: Option<&String>) -> &'static str {
    match sort.map(|value| value.to_ascii_lowercase()).as_deref() {
        Some("price-desc") => "price_pkn desc nulls last, updated_at desc, created_at desc",
        Some("qty") => "quantity_available desc nulls last, price_pkn asc, updated_at desc",
        Some("name") => "lower(coalesce(card_name, '')) asc, price_pkn asc",
        _ => "price_pkn asc nulls last, updated_at desc, created_at desc",
    }
}

/// Pokémon Singles, matching CardTrader category 73.
/// `catalogRarityExpr`: the printed rarity for a Pokémon candidate.
///
/// The stored column is "Card" for almost every single; the real label is the
/// collector-line prefix, otherwise CardTrader `fixed_properties.pokemon_rarity`.
pub fn catalog_rarity_expr(alias: &str, blueprint_alias: &str) -> String {
    // Plain newlines, not `\` continuations: a continuation eats the line
    // break and the indent, which turned `case` + `when` into `casewhen` and
    // made every Pokémon rarity filter a syntax error.
    format!(
        "coalesce(
    nullif(case
      when {alias}.card_number like '%|%'
        and lower(coalesce({alias}.rarity, '')) in ('', 'card')
      then btrim(split_part({alias}.card_number, '|', 1))
      else null
    end, ''),
    nullif(case
      when lower(coalesce({alias}.rarity, '')) not in ('', 'card') then {alias}.rarity
      else null
    end, ''),
    nullif({blueprint_alias}.blueprint#>>'{{fixed_properties,pokemon_rarity}}', ''),
    nullif({alias}.rarity, '')
  )"
    )
}

/// `pokemonBlueprintJoin`: the CardTrader blueprint carries the rarity when the
/// candidate column is the generic "Card".
pub fn pokemon_blueprint_join(alias: &str, blueprint_alias: &str) -> String {
    format!(
        "left join public.cardtrader_pokemon_blueprints {blueprint_alias}
      on ({alias}.card_id % 2) = 0
     and {blueprint_alias}.id = ({alias}.card_id / 2)"
    )
}

/// The rarity filter for one key: `(like patterns, exclude patterns, foil)`.
///
/// Returns `None` for an unknown key, which the caller ignores (no filter)
/// exactly like `raritySql`.
pub fn rarity_patterns(key: &str) -> Option<(Vec<&'static str>, Vec<&'static str>)> {
    let rarity = key.trim().to_ascii_lowercase();
    let patterns: (Vec<&'static str>, Vec<&'static str>) = match rarity.as_str() {
        "common" => (vec!["%common%"], vec!["%uncommon%"]),
        "uncommon" => (vec!["%uncommon%"], vec![]),
        "rare" => (
            vec!["%rare%"],
            vec!["%ultra%", "%secret%", "%illustration%", "%amazing%", "%uncommon%"],
        ),
        "ultra" => (vec!["%ultra%"], vec![]),
        "illustration" => (vec!["%illustration%"], vec![]),
        "secret" => (vec!["%secret%"], vec![]),
        "promo" => (vec!["%promo%"], vec![]),
        "no-rarity" => (vec!["%no rarity%"], vec![]),
        _ => return None,
    };
    Some(patterns)
}

/// `raritySql`: the WHERE clause plus the bound LIKE patterns.
///
/// Listings never store rarity text, so the filter runs against the catalog
/// (with the CardTrader blueprint for Pokémon). `holo` also accepts the listing's
/// own `foil_state`.
pub fn rarity_clause(key: &str, pokemon: bool) -> Option<(String, Vec<String>)> {
    let rarity = key.trim().to_ascii_lowercase();
    if rarity.is_empty() {
        return None;
    }
    let label = if pokemon {
        catalog_rarity_expr("c", "b")
    } else {
        "c.rarity".to_string()
    };
    let from = if pokemon {
        format!(
            "from public.marketplace_search_candidates c {}",
            pokemon_blueprint_join("c", "b")
        )
    } else {
        "from public.marketplace_search_candidates c".to_string()
    };
    let mut bound: Vec<String> = Vec::new();

    if rarity == "holo" {
        bound.push("%holo%".into());
        bound.push("%holofoil%".into());
        // Placeholders are resolved by the caller, which knows the bind offset.
        return Some((
            "HOLO_MARKER".to_string(),
            bound,
        ));
    }
    let (likes, excludes) = rarity_patterns(&rarity)?;
    for pattern in &likes {
        bound.push((*pattern).to_string());
    }
    for pattern in &excludes {
        bound.push((*pattern).to_string());
    }
    Some((
        format!(
            "exists (select 1 {from} where c.card_id::text = marketplace_user_listings.card_id and ({body}))",
            body = RARITY_BODY_MARKER
        ),
        bound,
    ))
}

/// Rendered by [`rarity_clause`]; the caller substitutes the placeholders.
pub const RARITY_BODY_MARKER: &str = "__RARITY_BODY__";
/// Marker for the `holo` special case.
pub const HOLO_MARKER: &str = "HOLO_MARKER";

fn pokemon_singles_where() -> &'static str {
    // `card_id` is bigint on the candidates: compare as bigint (its primary key)
    // behind a digits-only guard, which also keeps `::bigint` from overflowing.
    // Non-numeric listing ids never matched either branch before.
    r#"(
        marketplace_user_listings.card_id ~ '^[0-9]{1,18}$'
        and (
        exists (
          select 1 from public.marketplace_search_candidates c
          where c.card_id = marketplace_user_listings.card_id::bigint
            and c.product_type = 'card'
            and c.item_kind = 'single'
        )
        or (
          (marketplace_user_listings.card_id::bigint % 2) = 0
          and exists (
            select 1 from public.cardtrader_pokemon_blueprints b
            where b.category_id = 73
              and b.id = (marketplace_user_listings.card_id::bigint / 2)
          )
          and not exists (
            select 1 from public.marketplace_search_candidates c
            where c.card_id = marketplace_user_listings.card_id::bigint
          )
        )
        )
      )"#
}

fn listing_row(row: &sqlx::postgres::PgRow, seller: &Seller) -> Value {
    let quantity = number_i64(row, "quantity_available").unwrap_or(0);
    let created: Option<chrono::DateTime<chrono::Utc>> = row.try_get("created_at").ok();
    let updated: Option<chrono::DateTime<chrono::Utc>> = row.try_get("updated_at").ok();
    json!({
        "id": row.try_get::<uuid::Uuid, _>("id").map(|id| id.to_string()).unwrap_or_default(),
        "cardId": row.try_get::<String, _>("card_id").unwrap_or_default(),
        "sellerUid": seller.uid,
        "sellerName": seller.display_name,
        "sellerDisplayName": seller.display_name,
        "sellerUsername": seller.username,
        "sellerCountry": row.try_get::<Option<String>, _>("seller_country").ok().flatten(),
        "marketplaceGame": row.try_get::<Option<String>, _>("marketplace_game").ok().flatten().unwrap_or_else(|| "pokemon".into()),
        "condition": row.try_get::<Option<String>, _>("condition").ok().flatten(),
        "language": row.try_get::<Option<String>, _>("language").ok().flatten(),
        "pricePkn": number_f64(row, "price_pkn").unwrap_or(0.0),
        "sellerAcceptsPkn": seller.accepts_pkn,
        "quantityAvailable": quantity,
        "signed": row.try_get::<Option<bool>, _>("signed").ok().flatten().unwrap_or(false),
        "reverse": row.try_get::<Option<bool>, _>("reverse").ok().flatten().unwrap_or(false),
        "firstEdition": row.try_get::<Option<bool>, _>("first_edition").ok().flatten().unwrap_or(false),
        "altered": row.try_get::<Option<bool>, _>("altered").ok().flatten().unwrap_or(false),
        "foilState": row.try_get::<Option<String>, _>("foil_state").ok().flatten().unwrap_or_else(|| "standard".into()),
        "variantState": row.try_get::<Option<String>, _>("variant_state").ok().flatten().unwrap_or_default(),
        "sealed": row.try_get::<Option<bool>, _>("sealed").ok().flatten().unwrap_or(false),
        "graded": row.try_get::<Option<bool>, _>("graded").ok().flatten().unwrap_or(false),
        "shippingAvailable": row.try_get::<Option<bool>, _>("shipping_available").ok().flatten().unwrap_or(true),
        "cardName": row.try_get::<Option<String>, _>("card_name").ok().flatten(),
        "cardImageUrl": row.try_get::<Option<String>, _>("card_image_url").ok().flatten(),
        "setName": row.try_get::<Option<String>, _>("set_name").ok().flatten(),
        "collectorNumber": row.try_get::<Option<String>, _>("collector_number").ok().flatten(),
        "status": row.try_get::<Option<String>, _>("status").ok().flatten(),
        "createdAt": created.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        "updatedAt": updated.map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    })
}

/// The printed rarity of a listing's card, as one column of the book query.
fn book_rarity_column(pokemon: bool) -> String {
    if pokemon {
        // Same expression and join the rarity filter uses, by the candidates'
        // bigint key behind the digits guard the singles filter relies on.
        format!(
            "(case when marketplace_user_listings.card_id ~ '^[0-9]{{1,18}}$' then (
                select {label} from public.marketplace_search_candidates c {join}
                 where c.card_id = marketplace_user_listings.card_id::bigint limit 1) end)",
            label = catalog_rarity_expr("c", "b"),
            join = pokemon_blueprint_join("c", "b"),
        )
    } else {
        "(select c.rarity from public.marketplace_search_candidates c
           where c.card_id::text = marketplace_user_listings.card_id limit 1)"
            .to_string()
    }
}

/// The whole-book answer, serialized: plain JSON, or the `c1` columnar form
/// when the page asked for it (a tenth of the bytes for a big shop).
fn book_body(
    rows: &[sqlx::postgres::PgRow],
    seller: &Seller,
    game: &str,
    stamp: &str,
    compact: Wanted,
) -> Vec<u8> {
    let mut copies: i64 = 0;
    let listings: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut listing = listing_row(row, seller);
            copies += listing["quantityAvailable"].as_i64().unwrap_or(0);
            listing["rarity"] = json!(row.try_get::<Option<String>, _>("rarity").ok().flatten());
            listing
        })
        .collect();
    let book = json!({
        "book": true,
        "game": game,
        "seller": seller_payload(seller, None),
        "listings": listings,
        "total": rows.len(),
        "unique": rows.len(),
        "copies": copies,
        "maxUpdatedAt": stamp,
        "limit": rows.len(),
        "offset": 0,
    });
    if compact.c1() {
        compact_encode::encode_to_vec_with(&book, compact.encode_options())
    } else {
        serde_json::to_vec(&book).unwrap_or_default()
    }
}

/// Serialized books kept between requests, newest last.
const BOOK_CACHE_ENTRIES: usize = 12;
/// A book past this size is rebuilt every time rather than held in memory.
const BOOK_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

type BookCache = std::sync::Mutex<std::collections::VecDeque<(String, std::sync::Arc<Vec<u8>>)>>;

fn book_cache() -> &'static BookCache {
    static CACHE: std::sync::OnceLock<BookCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn book_cache_get(key: &str) -> Option<std::sync::Arc<Vec<u8>>> {
    let cache = book_cache().lock().ok()?;
    cache.iter().find(|(stored, _)| stored == key).map(|(_, body)| body.clone())
}

fn book_cache_put(key: String, body: std::sync::Arc<Vec<u8>>) {
    if body.len() > BOOK_CACHE_MAX_BYTES {
        return;
    }
    let Ok(mut cache) = book_cache().lock() else { return };
    // One book per seller, game and form: a new stamp replaces the old one.
    let scope = |key: &str| {
        let mut parts = key.split('|');
        (parts.next().map(str::to_owned), parts.next().map(str::to_owned), parts.nth(1).map(str::to_owned), parts.next().map(str::to_owned))
    };
    let mine = scope(&key);
    cache.retain(|(stored, _)| scope(stored) != mine);
    cache.push_back((key, body));
    while cache.len() > BOOK_CACHE_ENTRIES {
        cache.pop_front();
    }
}

/// `private_json` for a book that is already serialized.
fn book_response(body: std::sync::Arc<Vec<u8>>, compact: Wanted) -> Response {
    let mut headers = vec![("cache-control", "private, no-store"), ("vary", "Accept")];
    let content_type = if compact.c1() {
        headers.push(C1_FORMAT_HEADER);
        C1_CONTENT_TYPE
    } else {
        "application/json"
    };
    pokoin_api_common::http::raw(axum::http::StatusCode::OK, content_type, body.as_ref().clone(), &headers)
}

#[derive(Debug, Clone)]
struct Seller {
    uid: String,
    username: String,
    display_name: String,
    accepts_pkn: bool,
}

async fn seller_profile_for_username(
    state: &DomainState,
    username: &str,
) -> Result<Seller, ApiError> {
    let clean = clean_username(username);
    if clean.is_empty() {
        return Err(ApiError::bad_request("Seller username is invalid."));
    }
    let firestore = state.firestore()?;
    // Native registry first (`usernames/{username}`), then the listing name.
    let mut via_listing = false;
    let (uid, handle, display, accepts_pkn) =
        match store::uid_for_username(firestore, &clean).await? {
            Some(uid) => {
                // Cache-first public fields (`_seller_profile_cache.js`); a cache
                // miss reads `users/{uid}` and the value is never used for
                // authorisation.
                let cache = state.profile_cache();
                let profiles = crate::seller_cache::read_public_profiles(
                    cache
                        .as_ref()
                        .map(|cache| cache as &dyn crate::seller_cache::ProfileCache),
                    firestore,
                    std::slice::from_ref(&uid),
                )
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
                let profile = profiles.get(&uid).cloned().unwrap_or_default();
                (uid, profile.username, profile.display_name, profile.accepts_pkn)
            }
            None => {
                via_listing = true;
                let uid = sqlx::query_scalar::<_, String>(
                    "select seller_uid from public.marketplace_user_listings
                      where lower(btrim(seller_name)) = $1
                        and seller_uid is not null and btrim(seller_uid) <> ''
                      order by updated_at desc nulls last, created_at desc nulls last
                      limit 1",
                )
                .bind(&clean)
                .fetch_optional(state.read_db())
                .await?;
                let Some(uid) = uid else {
                    return Err(ApiError::not_found("Seller not found."));
                };
                (uid, clean.clone(), clean.clone(), true)
            }
        };
    if uid.trim().is_empty() {
        return Err(ApiError::not_found("Seller not found."));
    }
    let current = clean_username(&handle);
    // Mirror `shopSellerFromProfile`: a listing-name match must still agree.
    if via_listing && !current.is_empty() && current != clean {
        return Err(ApiError::not_found("Seller not found."));
    }
    let display_name = if display.is_empty() || display.contains('@') {
        if current.is_empty() {
            clean.clone()
        } else {
            current.clone()
        }
    } else {
        display
    };
    Ok(Seller {
        uid,
        username: if current.is_empty() { clean } else { current },
        display_name,
        accepts_pkn,
    })
}

pub async fn marketplace_seller_shop(
    State(state): State<DomainState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let username = query
        .get("sellerUsername")
        .cloned()
        .unwrap_or_default();
    if username.trim().is_empty() {
        return Err(ApiError::bad_request("sellerUsername is required."));
    }
    let seller = seller_profile_for_username(&state, &username).await?;
    let game = query
        .get("game")
        .map(|value| super::cart::normalize_game(value).unwrap_or("pokemon"))
        .unwrap_or("pokemon");
    let catalog_game = if game.is_empty() { "pokemon" } else { game };

    let limit = clean_limit(query.get("limit"));
    let offset = clean_offset(query.get("offset"));
    let book = truthy_flag(query.get("book"));
    let q = query.get("q").map(|value| value.trim().to_lowercase()).unwrap_or_default();
    let condition = query.get("condition").cloned().unwrap_or_default();
    let language = query
        .get("language")
        .map(|value| value.trim().to_ascii_uppercase())
        .unwrap_or_default();
    let rarity = query
        .get("rarity")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let reverse_only = truthy_flag(query.get("reverse"));
    let first_edition_only = truthy_flag(query.get("firstEdition"));
    let sort = query.get("sort").cloned();

    // Pokémon reads the shared marketplace replica; a satellite game reads its
    // own catalog database (`<GAME>_MARKETPLACE_DATABASE_URL`).
    let Some(pools) = state.game_pools(catalog_game).await else {
        return Err(DomainState::game_catalog_unconfigured(catalog_game));
    };
    let read_db = &pools.read;

    let mut values: Vec<Value> = vec![json!(seller.uid)];
    let mut where_clauses: Vec<String> = vec![
        "seller_uid = $1".into(),
        "status = 'active'".into(),
        "quantity_available > 0".into(),
    ];
    // The singles filter reads optional catalog/blueprint tables. It is a
    // visual facet, not a financial contract, so a replica that has not been
    // provisioned with those tables degrades to the unfiltered book instead of
    // failing the whole shop.
    let mut optional_visual_clause: Option<String> = None;
    if catalog_game == "pokemon" {
        let clause = pokemon_singles_where().to_string();
        where_clauses.push(clause.clone());
        optional_visual_clause = Some(clause);
    } else {
        // Satellite shops scope by the game catalog's card ids and game tag,
        // matching `sellerCardIdsForGame` in the Node handler.
        let listed = sqlx::query_scalar::<_, String>(
            "select distinct card_id from public.marketplace_user_listings
              where seller_uid = $1 and nullif(card_id, '') is not null",
        )
        .bind(&seller.uid)
        .fetch_all(read_db)
        .await
        .map_err(|error| crate::game::catalog_error(catalog_game, error))?;
        let catalog_ids: Vec<String> = if listed.is_empty() {
            Vec::new()
        } else {
            sqlx::query_scalar::<_, String>(
                "select card_id::text from public.marketplace_search_candidates
                  where card_id::text = any($1::text[])",
            )
            .bind(&listed)
            .fetch_all(read_db)
            .await
            .map_err(|error| crate::game::catalog_error(catalog_game, error))?
        };
        values.push(json!(catalog_ids));
        let index = values.len();
        where_clauses.push(format!("card_id = any(${index}::text[])"));
        values.push(json!(catalog_game));
        let index = values.len();
        where_clauses.push(format!("marketplace_game = ${index}"));
    }
    if !book && !q.is_empty() {
        values.push(json!(format!("%{q}%")));
        let index = values.len();
        where_clauses.push(format!(
            "(lower(coalesce(card_name, '')) like ${index}
              or lower(coalesce(set_name, '')) like ${index}
              or lower(coalesce(collector_number, '')) like ${index})"
        ));
    }
    if !book {
        if let Some(codes) = condition_codes(&condition) {
            values.push(json!(codes));
            let index = values.len();
            where_clauses.push(format!(
                "upper(btrim(coalesce(condition, ''))) = any(${index}::text[])"
            ));
        }
    }
    if !book && !language.is_empty() {
        values.push(json!(format!("{language}%")));
        let index = values.len();
        where_clauses.push(format!("upper(coalesce(language, '')) like ${index}"));
    }
    if !book && reverse_only {
        where_clauses.push("reverse = true".into());
    }
    if !book && first_edition_only {
        where_clauses.push("first_edition = true".into());
    }
    if !book && !rarity.is_empty() {
        let pokemon = catalog_game == "pokemon";
        if let Some((clause, bound)) = rarity_clause(&rarity, pokemon) {
            let first = values.len() + 1;
            for pattern in &bound {
                values.push(json!(pattern));
            }
            let label = if pokemon {
                catalog_rarity_expr("c", "b")
            } else {
                "c.rarity".to_string()
            };
            let rendered = if clause == HOLO_MARKER {
                format!(
                    "(lower(coalesce(foil_state, '')) in ('holo', 'holofoil')
                      or exists (select 1 {from}
                        where c.card_id::text = marketplace_user_listings.card_id
                          and (lower(coalesce({label}, '')) like ${a}
                               or lower(coalesce({label}, '')) like ${b})))",
                    from = if pokemon {
                        format!(
                            "from public.marketplace_search_candidates c {}",
                            pokemon_blueprint_join("c", "b")
                        )
                    } else {
                        "from public.marketplace_search_candidates c".to_string()
                    },
                    a = first,
                    b = first + 1,
                )
            } else {
                let likes: Vec<String> = (0..bound.len())
                    .map(|offset| format!("lower(coalesce({label}, '')) like ${}", first + offset))
                    .collect();
                let body = if likes.is_empty() {
                    "true".to_string()
                } else {
                    likes.join(" and ")
                };
                let from = if pokemon {
                    format!(
                        "from public.marketplace_search_candidates c {}",
                        pokemon_blueprint_join("c", "b")
                    )
                } else {
                    "from public.marketplace_search_candidates c".to_string()
                };
                format!(
                    "exists (select 1 {from} where c.card_id::text = marketplace_user_listings.card_id and ({body}))"
                )
            };
            let _ = RARITY_BODY_MARKER;
            where_clauses.push(rendered);
        }
    }
    let where_sql = where_clauses.join(" and ");

    let order = if book { sort_sql(Some(&"price-asc".into())) } else { sort_sql(sort.as_ref()) };

    let totals_sql = format!(
        "select count(*)::int as total, coalesce(sum(quantity_available), 0)::int as copies
           from public.marketplace_user_listings where {where_sql}"
    );
    if book {
        // The whole shop, whatever its size: the page filters, sorts and
        // pages it locally. Rarity rides along so the rarity filter is local
        // too; a catalog without those tables sends the book without it.
        let compact = Wanted::from_parts(None, &format!("format={}", query.get("format").map(String::as_str).unwrap_or("")));
        // The seller's last change names the book: until it moves, the bytes
        // built for one visitor serve the next without touching the listings.
        let stamp = seller_activity_stamp(read_db, &seller.uid)
            .await
            .map_err(|error| crate::game::catalog_error(catalog_game, error))?;
        let cache_key = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            seller.uid, catalog_game, stamp, compact.c1(), compact.templates(), seller.display_name, seller.accepts_pkn
        );
        if let Some(body) = book_cache_get(&cache_key) {
            return Ok(book_response(body, compact));
        }
        let rarity_column = book_rarity_column(catalog_game == "pokemon");
        let with_rarity = format!(
            "select {BOOK_COLUMNS}, {rarity_column} as rarity from public.marketplace_user_listings
              where {where_sql} order by {order}"
        );
        let plain = format!(
            "select {BOOK_COLUMNS} from public.marketplace_user_listings
              where {where_sql} order by {order}"
        );
        let rows = match run_shop_sql(
            read_db,
            catalog_game,
            &with_rarity,
            &values,
            &where_sql,
            optional_visual_clause.as_deref(),
        )
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(catalog_game, error = %error.message, "seller book without rarity");
                run_shop_sql(
                    read_db,
                    catalog_game,
                    &plain,
                    &values,
                    &where_sql,
                    optional_visual_clause.as_deref(),
                )
                .await?
            }
        };
        // Thousands of rows to shape and serialize: off the request workers,
        // so a big book never holds the three the Pi runs everything on.
        let game = catalog_game.to_string();
        let seller = seller.clone();
        let body = tokio::task::spawn_blocking(move || book_body(&rows, &seller, &game, &stamp, compact))
            .await
            .map_err(|error| {
                tracing::error!(%error, "seller book task failed");
                ApiError::internal("Seller shop failed.")
            })?;
        let body = std::sync::Arc::new(body);
        book_cache_put(cache_key, body.clone());
        return Ok(book_response(body, compact));
    }

    let totals_rows = run_shop_sql(
        read_db,
        catalog_game,
        &totals_sql,
        &values,
        &where_sql,
        optional_visual_clause.as_deref(),
    )
    .await?;
    let totals = totals_rows
        .first()
        .ok_or_else(|| crate::game::catalog_error(catalog_game, "no totals row"))?;
    let total: i32 = totals.try_get("total").unwrap_or(0);
    let copies: i32 = totals.try_get("copies").unwrap_or(0);

    let mut page_values = values.clone();
    page_values.push(json!(limit));
    page_values.push(json!(offset));
    let page_sql = format!(
        "select * from public.marketplace_user_listings
          where {where_sql} order by {order} limit ${} offset ${}",
        page_values.len() - 1,
        page_values.len()
    );
    let rows = run_shop_sql(
        read_db,
        catalog_game,
        &page_sql,
        &page_values,
        &where_sql,
        optional_visual_clause.as_deref(),
    )
    .await?;
    let listings: Vec<Value> = rows.iter().map(|row| listing_row(row, &seller)).collect();

    Ok(private_json(json!({
        "game": catalog_game,
        "seller": seller_payload(&seller, None),
        "listings": listings,
        "total": total,
        "unique": total,
        "copies": copies,
        "limit": limit,
        "offset": offset,
    })))
}

/// Run a seller-shop statement, retrying once without the optional visual
/// clause when the replica lacks the catalog/blueprint tables.
async fn run_shop_sql<'a>(
    read_db: &sqlx::PgPool,
    catalog_game: &str,
    sql: &'a str,
    values: &[Value],
    where_sql: &str,
    optional_clause: Option<&str>,
) -> Result<Vec<sqlx::postgres::PgRow>, ApiError> {
    let attempt = |statement: String, bound: Vec<Value>| {
        let bound = bound.to_vec();
        async move {
            let mut query_builder = sqlx::query(&statement);
            for value in &bound {
                query_builder = bind_json(query_builder, value);
            }
            query_builder.fetch_all(read_db).await
        }
    };
    match attempt(sql.to_string(), values.to_vec()).await {
        Ok(rows) => Ok(rows),
        Err(error) => {
            let Some(clause) = optional_clause else {
                return Err(crate::game::catalog_error(catalog_game, error));
            };
            if !is_missing_optional_relation(&error) {
                return Err(crate::game::catalog_error(catalog_game, error));
            }
            tracing::warn!(
                catalog_game,
                "optional visual catalog table missing on this replica; serving the shop without it"
            );
            let degraded_where = where_sql.replacen(clause, "true", 1);
            let degraded_sql = sql.replacen(where_sql, &degraded_where, 1);
            attempt(degraded_sql, values.to_vec())
                .await
                .map_err(|error| crate::game::catalog_error(catalog_game, error))
        }
    }
}

/// True when Postgres says an optional catalog/blueprint relation is absent
/// (e.g. `relation "cardtrader_pokemon_blueprints" does not exist` on a replica
/// that only carries the marketplace tables).
fn is_missing_optional_relation(error: &sqlx::Error) -> bool {
    let text = error.to_string().to_ascii_lowercase();
    text.contains("does not exist")
        || text.contains("undefined table")
        || text.contains("undefined_table")
}

fn seller_payload(seller: &Seller, photo_url: Option<String>) -> Value {
    json!({
        "uid": seller.uid,
        "username": seller.username,
        "displayName": seller.display_name,
        "photoUrl": photo_url,
        "acceptsPkn": seller.accepts_pkn,
    })
}

fn bind_json<'a>(
    query: sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments>,
    value: &Value,
) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match value {
        Value::String(text) => query.bind(text.clone()),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                query.bind(int)
            } else {
                query.bind(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::Bool(flag) => query.bind(*flag),
        Value::Array(rows) => {
            let list: Vec<String> = rows
                .iter()
                .filter_map(|row| row.as_str().map(|value| value.to_string()))
                .collect();
            query.bind(list)
        }
        Value::Null => query.bind(Option::<String>::None),
        _ => query.bind(value.to_string()),
    }
}

async fn seller_activity_stamp(
    read_db: &sqlx::PgPool,
    uid: &str,
) -> Result<String, sqlx::Error> {
    let stamp: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "select max(updated_at) from public.marketplace_user_listings where seller_uid = $1",
    )
    .bind(uid)
    .fetch_one(read_db)
    .await?;
    Ok(stamp
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------
// /api/marketplace-seller-settings
// ---------------------------------------------------------------------------

/// Seller ship-from country, PKN policy and Stripe Connect readiness on the
/// Firestore `users/{uid}` document — the same fields the Node writer used.
async fn read_settings(state: &DomainState, uid: &str) -> Result<Value, ApiError> {
    let user = store::read_user(state.firestore()?, uid).await?;
    let country = normalize_country(
        user.get("shipFromCountry")
            .or_else(|| user.get("ship_from_country"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let source = user
        .get("shipFromCountrySource")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let source = if country.is_empty() {
        String::new()
    } else if source == "ip" || source == "user" {
        source
    } else {
        "user".into()
    };
    Ok(json!({
        "shipFromCountry": country,
        "shipFromCountrySource": source,
        "stripeConnectAccountId": user
            .get("stripeConnectAccountId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "stripeConnectStatus": user
            .get("stripeConnectStatus")
            .and_then(Value::as_str)
            .unwrap_or("not_started"),
        "acceptsPkn": user.get("acceptsPkn").and_then(Value::as_bool).unwrap_or(true),
    }))
}

pub async fn marketplace_seller_settings_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let firestore = state.firestore()?;
    if let Some(sellers) = query.get("sellers") {
        let mut refusing = Vec::new();
        for uid in sellers.split(',').take(50) {
            let uid = uid.trim();
            if uid.is_empty() {
                continue;
            }
            let user = store::read_user(firestore, uid).await?;
            if user.as_object().map(|object| object.is_empty()).unwrap_or(true) {
                continue;
            }
            if user.get("acceptsPkn").and_then(Value::as_bool).unwrap_or(true) == false {
                let name = user
                    .get("username")
                    .or_else(|| user.get("displayName"))
                    .and_then(Value::as_str)
                    .unwrap_or("This seller")
                    .to_string();
                refusing.push(json!({ "uid": uid, "name": name }));
            }
        }
        return Ok(private_json(json!({ "pknRefused": refusing })));
    }

    let mut settings = read_settings(&state, &claims.uid).await?;
    if settings
        .get("shipFromCountry")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .is_empty()
    {
        let from_ip = ship_from_country_from_request(&headers);
        if !from_ip.is_empty() {
            store::write_user(
                firestore,
                &claims.uid,
                json!({
                    "shipFromCountry": from_ip,
                    "shipFromCountrySource": "ip",
                }),
            )
            .await?;
            let stamped = stamp_seller_country(&state, &claims.uid, &from_ip).await;
            settings = read_settings(&state, &claims.uid).await?;
            if let Some(object) = settings.as_object_mut() {
                object.insert("suggestedShipFromCountry".into(), json!(from_ip));
                object.insert("seededFromIp".into(), json!(true));
                object.insert("listingsStamped".into(), json!(stamped));
            }
            return Ok(private_json(settings));
        }
        if let Some(object) = settings.as_object_mut() {
            object.insert("suggestedShipFromCountry".into(), json!(""));
            object.insert("seededFromIp".into(), json!(false));
        }
        return Ok(private_json(settings));
    }
    Ok(private_json(settings))
}

async fn stamp_seller_country(state: &DomainState, uid: &str, country: &str) -> u64 {
    let code = normalize_country(country);
    if code.is_empty() {
        return 0;
    }
    sqlx::query(
        "update public.marketplace_user_listings
            set seller_country = $2, updated_at = now()
          where seller_uid = $1
            and coalesce(upper(seller_country), '') is distinct from $2",
    )
    .bind(uid)
    .bind(&code)
    .execute(state.write_db())
    .await
    .map(|result| result.rows_affected())
    .unwrap_or(0)
}

pub async fn marketplace_seller_settings_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let firestore = state.firestore()?;
    let mut listings_stamped = 0u64;
    if body.get("shipFromCountry").is_some() {
        let country = crate::domain::country::assert_ship_from_country(&text_field(
            &body,
            &["shipFromCountry"],
            40,
        ))?;
        store::write_user(
            firestore,
            &claims.uid,
            json!({
                "shipFromCountry": country,
                "shipFromCountrySource": "user",
            }),
        )
        .await?;
        listings_stamped = stamp_seller_country(&state, &claims.uid, &country).await;
    }
    if let Some(accepts) = body.get("acceptsPkn").and_then(Value::as_bool) {
        store::write_user(firestore, &claims.uid, json!({ "acceptsPkn": accepts })).await?;
    }
    // Server-side writes that touch cached public fields invalidate them
    // (`_seller_profile_cache.js`); the TTL is the bound for client-side renames.
    if body.get("acceptsPkn").is_some() || body.get("shipFromCountry").is_some() {
        let handle = store::read_user(firestore, &claims.uid)
            .await
            .ok()
            .and_then(|user| {
                user.get("username")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
            })
            .unwrap_or_default();
        let cache = state.profile_cache();
        crate::seller_cache::invalidate_seller_profile(
            cache
                .as_ref()
                .map(|cache| cache as &dyn crate::seller_cache::ProfileCache),
            &claims.uid,
            &handle,
        )
        .await;
    }
    let mut settings = read_settings(&state, &claims.uid).await?;
    if let Some(object) = settings.as_object_mut() {
        object.insert("listingsStamped".into(), json!(listings_stamped));
    }
    Ok(private_json(settings))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_chips_map_to_stored_codes() {
        assert_eq!(condition_codes("NM"), Some(vec!["NM", "M"]));
        assert_eq!(condition_codes("sp"), Some(vec!["SP", "LP"]));
        assert_eq!(condition_codes("PL"), Some(vec!["PL", "HP"]));
        assert_eq!(condition_codes("Poor"), Some(vec!["PO", "POOR", "D", "DMG"]));
        assert_eq!(condition_codes("nope"), None);
        assert_eq!(condition_codes(""), None);
    }

    #[test]
    fn sort_options_match_the_reference() {
        assert!(sort_sql(Some(&"price-desc".into())).starts_with("price_pkn desc"));
        assert!(sort_sql(Some(&"qty".into())).starts_with("quantity_available desc"));
        assert!(sort_sql(Some(&"name".into())).starts_with("lower(coalesce(card_name"));
        assert!(sort_sql(None).starts_with("price_pkn asc"));
    }

    #[test]
    fn pagination_guards_match_the_reference() {
        assert_eq!(clean_limit(None), PAGE_DEFAULT);
        assert_eq!(clean_limit(Some(&"0".into())), 1);
        assert_eq!(clean_limit(Some(&"1000".into())), 200);
        assert_eq!(clean_offset(Some(&"-1".into())), 0);
        assert_eq!(clean_offset(Some(&"999999".into())), 50_000);
    }

    #[test]
    fn usernames_are_cleaned_like_the_reference() {
        assert_eq!(clean_username(" @RedShakkio "), "redshakkio");
        assert_eq!(clean_username(""), "");
    }

    #[test]
    fn truthy_flags_follow_the_query_convention() {
        for value in ["1", "true", "yes", "on", "TRUE"] {
            assert!(truthy_flag(Some(&value.to_string())), "{value}");
        }
        for value in ["0", "false", "no", "", "x"] {
            assert!(!truthy_flag(Some(&value.to_string())), "{value}");
        }
    }

    #[test]
    fn missing_optional_relations_are_detected() {
        // A replica without the optional catalog/blueprint tables reports a
        // missing relation, which is the only case that degrades gracefully.
        let missing = sqlx::Error::Database(Box::new(FakeDbError(
            "ERROR: relation \"public.cardtrader_pokemon_blueprints\" does not exist".into(),
        )));
        assert!(is_missing_optional_relation(&missing));
        let undefined = sqlx::Error::Database(Box::new(FakeDbError(
            "undefined_table".into(),
        )));
        assert!(is_missing_optional_relation(&undefined));
        // Financial and other failures stay strict.
        let other = sqlx::Error::Database(Box::new(FakeDbError(
            "permission denied for table marketplace_user_listings".into(),
        )));
        assert!(!is_missing_optional_relation(&other));
        let timeout = sqlx::Error::PoolTimedOut;
        assert!(!is_missing_optional_relation(&timeout));
    }

    #[derive(Debug)]
    struct FakeDbError(String);

    impl std::fmt::Display for FakeDbError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(&self.0)
        }
    }

    impl std::error::Error for FakeDbError {}

    impl sqlx::error::DatabaseError for FakeDbError {
        fn message(&self) -> &str {
            &self.0
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
    }
}

#[cfg(test)]
mod book_tests {
    use super::*;

    #[test]
    fn rarity_expression_keeps_its_keywords_apart() {
        let sql = catalog_rarity_expr("c", "b");
        let words: Vec<&str> = sql.split_whitespace().collect();
        for keyword in ["when", "and", "then", "else", "end,"] {
            assert!(words.contains(&keyword), "{keyword} is not a word of its own in: {sql}");
        }
        assert!(!sql.contains("casewhen") && !sql.contains("nullthen") && !sql.contains("nullend"));
        let column = book_rarity_column(true);
        assert!(column.contains("c.card_id = marketplace_user_listings.card_id::bigint"));
    }

    /// The rarity expression and the book's rarity column run on Postgres and
    /// pick the collector-line prefix, then the stored rarity, then the
    /// CardTrader blueprint.
    #[tokio::test]
    async fn rarity_sql_runs_and_reads_the_printed_rarity() {
        let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
            eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect(&url).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        sqlx::raw_sql(
            "create schema if not exists public;
             drop table if exists public.marketplace_search_candidates, public.cardtrader_pokemon_blueprints cascade;
             create table public.marketplace_search_candidates (card_id bigint primary key, card_number text, rarity text);
             create table public.cardtrader_pokemon_blueprints (id bigint primary key, blueprint jsonb);
             insert into public.marketplace_search_candidates values
               (10, 'Rare | 119/214', 'Card'), (12, '4/102', 'Holo Rare'), (14, '7/62', 'Card'), (16, '1/1', null);
             insert into public.cardtrader_pokemon_blueprints values
               (7, '{\"fixed_properties\": {\"pokemon_rarity\": \"Uncommon\"}}');
             drop table if exists pg_temp.shop;
             create temp table shop as select * from (values ('10'), ('12'), ('14'), ('16'), ('abc'), ('99')) v(card_id);",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        let column = book_rarity_column(true).replace("marketplace_user_listings", "shop");
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as(&format!("select card_id, {column} as rarity from shop order by card_id"))
                .fetch_all(&mut *conn)
                .await
                .unwrap();
        let rarity = |id: &str| rows.iter().find(|row| row.0 == id).unwrap().1.clone();
        assert_eq!(rarity("10").as_deref(), Some("Rare"), "collector-line prefix");
        assert_eq!(rarity("12").as_deref(), Some("Holo Rare"), "stored rarity");
        assert_eq!(rarity("14").as_deref(), Some("Uncommon"), "CardTrader blueprint");
        assert_eq!(rarity("16"), None);
        assert_eq!(rarity("abc"), None, "a non-numeric listing id has no candidate");
        assert_eq!(rarity("99"), None);
        sqlx::raw_sql("drop table public.marketplace_search_candidates, public.cardtrader_pokemon_blueprints cascade")
            .execute(&mut *conn)
            .await
            .unwrap();
    }

    /// A 10,000-listing shop comes back whole, as one valid JSON book.
    /// `POKOIN_TEST_DATABASE_URL=postgres://… cargo test -p pokoin-commerce book_of_ten_thousand -- --nocapture`
    #[tokio::test]
    async fn book_of_ten_thousand_listings_is_complete() {
        let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
            eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
        // Temp tables are per connection: create and read on the same one.
        let mut conn = pool.acquire().await.unwrap();
        sqlx::raw_sql(
            "drop table if exists pg_temp.book_rows;
             create temp table book_rows as
             select gen_random_uuid() as id, (200000 + n)::text as card_id, (case when n % 3 = 0 then 'Common' else 'Rare Holo' end)::text as rarity, 'IT'::text as seller_country,
                    'pokemon'::text as marketplace_game, 'NM'::text as condition, 'EN'::text as language,
                    (100 + n)::numeric as price_pkn, 2::integer as quantity_available,
                    false as signed, (n % 7 = 0) as reverse, false as first_edition, false as altered,
                    'standard'::text as foil_state, ''::text as variant_state, false as sealed, false as graded,
                    true as shipping_available, ('Card name number ' || n)::text as card_name,
                    ('https://cdn.pokoin.com/leftovers/' || n || '.jpg')::text as card_image_url,
                    'Some Expansion Name'::text as set_name, (n % 200 || '/200')::text as collector_number,
                    'active'::text as status, now() as created_at, now() as updated_at
               from generate_series(1, 10000) n",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        let rows = sqlx::query("select * from book_rows order by price_pkn").fetch_all(&mut *conn).await.unwrap();
        assert_eq!(rows.len(), 10000);
        let seller = Seller { uid: "u1".into(), username: "alice".into(), display_name: "Alice".into(), accepts_pkn: true };
        let started = std::time::Instant::now();
        let body = book_body(&rows, &seller, "pokemon", "2026-10-11T00:00:00Z", Wanted::DEFAULT);
        let took = started.elapsed();
        let book: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(book["book"], true);
        assert_eq!(book["total"], 10000);
        assert_eq!(book["listings"].as_array().unwrap().len(), 10000);
        assert_eq!(book["copies"], 20000);
        assert_eq!(book["listings"][0]["pricePkn"], 101.0);
        assert_eq!(book["listings"][0]["quantityAvailable"], 2);
        assert_eq!(book["listings"][0]["rarity"], "Rare Holo");
        assert_eq!(book["listings"][2]["rarity"], "Common");
        assert_eq!(book["listings"][9999]["cardName"], "Card name number 10000");
        assert_eq!(book["seller"]["username"], "alice");

        // The compact form is the same book, exactly, in a fraction of the bytes.
        let wanted = Wanted::from_parts(None, "format=c1v2");
        let started = std::time::Instant::now();
        let compact = book_body(&rows, &seller, "pokemon", "2026-10-11T00:00:00Z", wanted);
        let compact_took = started.elapsed();
        let decoded = pokoin_api_common::compact::decode::decode(&serde_json::from_slice(&compact).unwrap()).unwrap();
        assert_eq!(decoded, book);
        assert!(compact.len() * 3 < body.len(), "{} vs {}", compact.len(), body.len());
        // One book per seller, game and form: a newer stamp replaces the older.
        let key = |stamp: &str| format!("u-cache|pokemon|{stamp}|true|true|Alice|true");
        book_cache_put(key("s1"), std::sync::Arc::new(vec![1]));
        assert_eq!(book_cache_get(&key("s1")).as_deref(), Some(&vec![1]));
        book_cache_put(key("s2"), std::sync::Arc::new(vec![2]));
        assert!(book_cache_get(&key("s1")).is_none());
        assert_eq!(book_cache_get(&key("s2")).as_deref(), Some(&vec![2]));
        book_cache_put(key("s3"), std::sync::Arc::new(vec![0; BOOK_CACHE_MAX_BYTES + 1]));
        assert!(book_cache_get(&key("s3")).is_none(), "an oversized book is not held");
        eprintln!(
            "book of {} rows: json {} bytes in {:?}; c1 {} bytes in {:?}",
            rows.len(), body.len(), took, compact.len(), compact_took
        );
    }
}
