//! Satellite (non-Pokémon) marketplace routes on a real Postgres: version-set, card-url,
//! card-sales and last-median read the request game's catalog DB (`?game=` or
//! `x-pokoin-game`), never the Pokémon replica.
//!
//! ```text
//! docker run -d --rm --name pokoin-satellite-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55491:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres \
//!   cargo test -p pokoin-catalog-api --test satellite_marketplace_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates the `sat_pokemon`, `sat_yugioh` and `sat_magic` databases.
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower::ServiceExt;

const SATELLITE_SCHEMA: &str = r#"
create extension if not exists pg_trgm;
create table public.marketplace_search_candidates (
  card_id bigint primary key, ct_id bigint not null, name text not null,
  source_name text not null default '', display_name text not null default '', canonical_name text not null default '',
  set_name text not null default '', card_number text not null default '', product_variant text not null default '',
  rarity text not null default 'Card', card_type text not null default 'Card',
  item_kind text not null default 'single', product_type text not null default 'card',
  trainer_name text not null default '', image_url text, cdn_image_url text, preview_image_url text, homepage_image_url text,
  card_palette jsonb not null default '{}'::jsonb, emoji text not null default '', search_text text not null default '',
  name_prefix text not null default '', set_prefix text not null default '', expansion_name text not null default '',
  search_weight numeric not null default 0, imported_at timestamptz, projected_at timestamptz not null default now(),
  set_order integer not null default 0);
create table public.marketplace_card_urls (
  card_id bigint primary key, ct_id bigint, language text not null default 'en', canonical_slug text,
  canonical_slug_normalized text, canonical_path text, canonical_path_normalized text, rarity text, name text,
  card_number text, set_name text, item_kind text, product_type text, is_unique boolean default true,
  duplicate_group_size integer default 1, duplicate_keys jsonb default '[]'::jsonb,
  source_projected_at timestamptz default now(), updated_at timestamptz default now());
create table public.pokoin_expansions (expansion_id integer primary key, name text not null default '',
  nationality text not null default 'unknown');
create table public.cardtrader_blueprint_listing_cache (provider text not null default 'cardtrader',
  blueprint_id bigint not null, pokoin_card_id text not null default '', cheapest_price_eur numeric,
  cheapest_price_pkn numeric, eligible_listing_count integer not null default 0, eligible_quantity integer not null default 0,
  sample_listing_id text not null default '', sample_product_id text not null default '', shipping_mode text not null default '',
  seller_country_code text not null default '', source_snapshot_at timestamptz, updated_at timestamptz not null default now());
create table public.marketplace_card_daily_median (card_id bigint primary key, last_day date,
  last_median_pkn numeric not null, refreshed_at timestamptz not null default now());
create view public.cheapest_homepage_cache_blueprint as
  select * from public.cardtrader_blueprint_listing_cache;
"#;

const POKEMON_SCHEMA: &str = r#"
create table public.marketplace_search_candidates (
  card_id bigint primary key, ct_id bigint not null, name text not null,
  source_name text not null default '', display_name text not null default '', canonical_name text not null default '',
  set_name text not null default '', card_number text not null default '', product_variant text not null default '',
  rarity text not null default 'Card', card_type text not null default 'Card',
  item_kind text not null default 'single', product_type text not null default 'card',
  trainer_name text not null default '', image_url text, cdn_image_url text, preview_image_url text, homepage_image_url text,
  card_palette jsonb not null default '{}'::jsonb, emoji text not null default '', search_text text not null default '',
  name_prefix text not null default '', set_prefix text not null default '', expansion_name text not null default '',
  search_weight numeric not null default 0, imported_at timestamptz, projected_at timestamptz not null default now(),
  set_order integer not null default 0, version text);
create table public.pokoin_version_sets (version text primary key, member_count integer);
create table public.pokoin_pokemon_expansions (name text, nationality text);
create table public.marketplace_card_urls (
  card_id bigint primary key, ct_id bigint, language text not null default 'en', canonical_slug text,
  canonical_slug_normalized text, canonical_path text, canonical_path_normalized text, rarity text, name text,
  card_number text, set_name text, item_kind text, product_type text, is_unique boolean default true,
  duplicate_group_size integer default 1, duplicate_keys jsonb default '[]'::jsonb,
  public_number bigint,
  source_projected_at timestamptz default now(), updated_at timestamptz default now());
"#;

async fn exec_all(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.expect("schema/seed sql");
}

async fn get(app: &axum::Router, uri: &str, game_header: Option<&str>) -> (StatusCode, Value) {
    let mut req = Request::builder().method("GET").uri(uri);
    if let Some(game) = game_header {
        req = req.header("x-pokoin-game", game);
    }
    let res = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 4 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn fresh_db(admin: &PgPool, base: &str, name: &str) -> (String, PgPool) {
    sqlx::query(&format!("drop database if exists {name} with (force)")).execute(admin).await.unwrap();
    sqlx::query(&format!("create database {name}")).execute(admin).await.unwrap();
    let url = format!("{}/{name}", base.rsplit_once('/').unwrap().0);
    let pool = PgPoolOptions::new().max_connections(2).connect(&url).await.unwrap();
    (url, pool)
}

fn printing_id(p: &Value) -> Option<i64> {
    for key in ["id", "card_id", "cardId"] {
        if let Some(v) = p.get(key) {
            if let Some(n) = v.as_i64() {
                return Some(n);
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn printing_path(p: &Value) -> Option<&str> {
    for key in ["canonicalPath", "canonical_path", "canonical_slug"] {
        if let Some(s) = p.get(key).and_then(|v| v.as_str()) {
            return Some(s);
        }
    }
    None
}

#[tokio::test]
async fn satellite_marketplace_routes_read_the_game_catalog() {
    let Ok(base) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("POKOIN_TEST_DATABASE_URL unset; skipping");
        return;
    };
    let admin = PgPoolOptions::new().max_connections(1).connect(&base).await.unwrap();
    let (_, pokemon) = fresh_db(&admin, &base, "sat_pokemon").await;
    let (yugioh_url, yugioh) = fresh_db(&admin, &base, "sat_yugioh").await;
    let (magic_url, magic) = fresh_db(&admin, &base, "sat_magic").await;

    exec_all(&pokemon, POKEMON_SCHEMA).await;
    exec_all(&yugioh, SATELLITE_SCHEMA).await;
    exec_all(&magic, SATELLITE_SCHEMA).await;

    for (pool, rows) in [
        (&yugioh, [
            (167046_i64, 83523_i64, "Charming Resort Staff", "Invasion: Vengeance", "086", "cha",
             "/marketplace/en/cards/167046/charming-resort-staff-invasion-vengeance-086"),
            (900002_i64, 450001_i64, "Charming Resort Staff", "Invasion: Vengeance OCG", "086", "cha",
             "/marketplace/en/cards/900002/charming-resort-staff-invasion-vengeance-ocg-086"),
            (900004_i64, 450002_i64, "Dark Magician", "Legend of Blue Eyes White Dragon", "LOB-005", "dar",
             "/marketplace/en/cards/900004/dark-magician-legend-of-blue-eyes-white-dragon-lob-005"),
        ].as_slice()),
        (&magic, [
            (4152_i64, 2076_i64, "Lightning Bolt", "Masters 25", "141", "lig",
             "/marketplace/en/cards/4152/lightning-bolt-masters-25-141"),
            (308608_i64, 207608_i64, "Lightning Bolt", "Mystical Archive: Japanese alternate-art", "105", "lig",
             "/marketplace/en/cards/308608/lightning-bolt-mystical-archive-japanese-alternate-art-105"),
            (36332_i64, 207632_i64, "Lightning Bolt", "Magic 2011", "149", "lig",
             "/marketplace/en/cards/36332/lightning-bolt-magic-2011-149"),
            (70000_i64, 207670_i64, "Shock", "Magic 2011", "156", "sho",
             "/marketplace/en/cards/70000/shock-magic-2011-156"),
        ].as_slice()),
    ] {
        for (card_id, ct_id, name, set_name, card_number, name_prefix, path) in rows {
            sqlx::query(
                "insert into public.marketplace_search_candidates \
                 (card_id, ct_id, name, set_name, card_number, name_prefix) values ($1,$2,$3,$4,$5,$6)",
            )
            .bind(card_id)
            .bind(ct_id)
            .bind(name)
            .bind(set_name)
            .bind(card_number)
            .bind(name_prefix)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                "insert into public.marketplace_card_urls \
                 (card_id, ct_id, language, canonical_slug, canonical_path) values ($1,$2,'en',$3,$4)",
            )
            .bind(card_id)
            .bind(ct_id)
            .bind(name.to_lowercase().replace(' ', "-"))
            .bind(path)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    std::env::set_var("YUGIOH_MARKETPLACE_DATABASE_URL", &yugioh_url);
    std::env::set_var("MAGIC_MARKETPLACE_DATABASE_URL", &magic_url);

    let state = pokoin_api_common::RouteState::new(
        pokoin_api_common::ApiState::new(pokemon.clone(), pokemon.clone(), None, 1),
        pokoin_accounts::DomainState::default(),
    );
    let app = pokoin_catalog_api::router(state);

    // 1. Yugioh version-set for 167046.
    let (status, body) = get(&app, "/api/marketplace-version-set?cardId=167046&game=yugioh", None).await;
    println!("yugioh version-set body: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cardId"], "167046");
    assert_eq!(body["versionCount"], 2);
    let printings = body["printings"].as_array().expect("printings array");
    assert_eq!(printings.len(), 2);
    assert_eq!(printing_id(&printings[0]), Some(167046));
    let nationalities: Vec<&str> = printings.iter().map(|p| p["nationality"].as_str().unwrap_or("")).collect();
    assert!(nationalities.contains(&"japanese"), "nationalities: {nationalities:?}");
    assert!(nationalities.contains(&"western"), "nationalities: {nationalities:?}");
    let version = body["version"].as_str().unwrap_or("");
    assert!(version.starts_with("name:"), "version: {version}");
    for p in printings {
        assert!(!printing_path(p).unwrap_or("").is_empty(), "empty canonical path in {p}");
    }

    // 2. Magic version-set 4152 through the game header.
    let (status, body) = get(&app, "/api/marketplace-version-set?cardId=4152", Some("magic")).await;
    println!("magic version-set body: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["versionCount"], 3);
    let printings = body["printings"].as_array().expect("printings array");
    assert_eq!(printings.len(), 3);
    assert_eq!(printing_id(&printings[0]), Some(4152));
    let mystical = printings
        .iter()
        .find(|p| p["set_name"].as_str().unwrap_or("").contains("Mystical Archive"))
        .expect("Mystical Archive printing");
    assert_eq!(mystical["nationality"], "japanese");
    for p in printings {
        assert_ne!(p["name"].as_str().unwrap_or(""), "Shock", "Shock must not be in the list: {p}");
    }

    // 3. Unknown card id.
    let (status, body) = get(&app, "/api/marketplace-version-set?cardId=999998&game=yugioh", None).await;
    println!("yugioh version-set 999998 body: {body}");
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, serde_json::json!({"error": "Card not found.", "cardId": "999998"}));

    // 4. Pokémon pool is separate: 167046 is not seeded there.
    for uri in ["/api/marketplace-version-set?cardId=167046", "/api/marketplace-version-set?cardId=167046&game=pokemon"] {
        let (status, body) = get(&app, uri, None).await;
        println!("pokemon version-set {uri} body: {body}");
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri} should read the Pokémon pool");
    }

    // 5. card-url.
    let (status, body) = get(&app, "/api/marketplace-card-url?cardId=167046&game=yugioh", None).await;
    println!("yugioh card-url body: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["cardId"], "167046");
    assert_eq!(
        body["canonicalPath"].as_str().unwrap_or(""),
        "/marketplace/en/cards/167046/charming-resort-staff-invasion-vengeance-086"
    );
    let (status, body) = get(&app, "/api/marketplace-card-url?cardId=167046", None).await;
    println!("card-url without game body: {body}");
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, serde_json::json!({"error": "Marketplace card URL not found."}));
    let (status, body) = get(&app, "/api/marketplace-card-url?cardId=4152&game=magic", None).await;
    println!("magic card-url body: {body}");
    assert_eq!(status, StatusCode::OK);

    // 6. card-sales for a satellite with no sold rows.
    let (status, body) = get(&app, "/api/marketplace-card-sales?cardId=167046&slices=1&game=yugioh", None).await;
    println!("yugioh card-sales slices body: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["slices"], Value::Array(Vec::new()));
    assert_eq!(body["soldData"], "unavailable");
    let (status, body) = get(&app, "/api/marketplace-card-sales?cardId=167046&game=yugioh", None).await;
    println!("yugioh card-sales full body: {body}");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["source"], "cardtrader_removed_sale");
    assert_eq!(body["soldData"], "unavailable");

    // 7. Magic card-sales with a sold row.
    exec_all(
        &magic,
        r#"
create table public.cardtrader_sold_daily (
  blueprint_id bigint, observed_day date, condition text, language text,
  reverse bool default false, first_edition bool default false, graded bool default false,
  median_pkn numeric, min_pkn numeric, max_pkn numeric, sold_qty int default 0, listings int default 0,
  graded_comments text[] default '{}', refreshed_at timestamptz default now(), sample_count int default 0);
insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty)
values (2076, '2026-10-17', 'Near Mint', 'en', 500, 450, 550, 2);
"#,
    )
    .await;
    let (status, body) = get(&app, "/api/marketplace-card-sales?cardId=4152&slices=1&game=magic", None).await;
    println!("magic card-sales slices body: {body}");
    assert_eq!(status, StatusCode::OK);
    let slices = body["slices"].as_array().expect("slices array");
    assert_eq!(slices.len(), 1, "slices: {slices:?}");
    assert_eq!(body.get("soldData"), None, "soldData should be absent: {body}");
    let slice = &slices[0];
    let day = slice.get("day").and_then(|v| v.as_str()).unwrap_or("");
    assert_eq!(day, "2026-10-17", "slice: {slice}");
    let median = slice.get("medianPkn").and_then(|v| v.as_f64()).unwrap_or(0.0);
    assert_eq!(median, 500.0, "slice: {slice}");
    let sold_qty = slice.get("soldQty").and_then(|v| v.as_i64()).unwrap_or(0);
    assert_eq!(sold_qty, 2, "slice: {slice}");

    // 8. last-median must not 500 on a satellite.
    let (status, body) = get(&app, "/api/marketplace-card-last-median?cardId=167046&game=yugioh", None).await;
    println!("yugioh last-median body: {body}");
    assert_eq!(status, StatusCode::OK);

    admin.close().await;
    pokemon.close().await;
    yugioh.close().await;
    magic.close().await;
}
