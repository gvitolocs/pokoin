//! `/api/marketplace-card-versions?productCategory=graded` on a real Postgres:
//! only cards with an active, shippable graded native listing come back, and
//! the listings are scanned once, not once per card version (that per-version
//! lateral spent 30 s in SQL and answered 500 in production).
//!
//! ```text
//! docker run -d --rm --name pokoin-graded-versions-test-pg -e POSTGRES_PASSWORD=test \
//!   -p 127.0.0.1:55481:5432 --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55481/postgres \
//!   cargo test -p pokoin-catalog-api --test graded_versions_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped. It drops and
//! recreates its tables.

use std::time::Instant;

use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;

use pokoin_catalog_api::shared::card_versions::{
    rows_for_versions, rows_for_versions_sql, RowsForVersionsArgs, SqlParam,
};

const SCHEMA: &str = "
drop table if exists public.marketplace_card_versions, public.marketplace_search_candidates,
  public.cardtrader_pokemon_blueprints, public.marketplace_blueprint_tcg_metadata,
  public.marketplace_user_listings, public.marketplace_cm_verified_links,
  public.marketplace_cm_product_parsing, public.pokoin_pokemon_expansions,
  public.marketplace_blueprint_artists, public.marketplace_card_urls cascade;
create table public.marketplace_card_versions (
  card_id bigint primary key, ct_id bigint unique, blueprint_id bigint, name text not null,
  expansion_name text not null, expansion_number text, product_variant text, image_url text,
  cdn_image_url text, preview_image_url text, homepage_image_url text, product_type text,
  trainer_name text, card_palette jsonb, emoji text, projected_at timestamptz default now());
create table public.marketplace_search_candidates (
  card_id bigint primary key, card_number text, rarity text, card_type text);
create table public.cardtrader_pokemon_blueprints (id bigint primary key, version text, blueprint jsonb);
create table public.marketplace_blueprint_tcg_metadata (card_id bigint, blueprint_id bigint, raw_metadata jsonb);
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  status text not null default 'active',
  price_pkn numeric not null,
  quantity_available integer not null default 1,
  shipping_available boolean not null default true,
  nft_available boolean not null default false,
  graded boolean not null default false,
  grading_company text not null default '',
  grade text not null default '',
  updated_at timestamptz not null default now());
create table public.marketplace_cm_verified_links (
  blueprint_id bigint, collector_number text, confidence text, verified_at timestamptz, updated_at timestamptz);
create table public.marketplace_cm_product_parsing (
  blueprint_id bigint, collector_number text, verified_at timestamptz, updated_at timestamptz);
create table public.pokoin_pokemon_expansions (name text, symbol_image_url text);
create table public.marketplace_blueprint_artists (card_id bigint, artist text, illustrator text);
create table public.marketplace_card_urls (card_id bigint, language text, canonical_path text);

insert into public.marketplace_card_versions
  (card_id, ct_id, blueprint_id, name, expansion_name, expansion_number, product_type, preview_image_url) values
  (10, 5, 5, 'Charizard', 'Base Set', '4/102', 'card', 'https://cdn/10.webp'),
  (12, 6, 6, 'Pikachu', 'Base Set', '58/102', 'card', 'https://cdn/12.webp'),
  (14, 7, 7, 'Mewtwo', 'Base Set', '10/102', 'card', 'https://cdn/14.webp'),
  (16, 8, 8, 'Blastoise', 'Base Set', '2/102', 'card', 'https://cdn/16.webp'),
  (18, 9, 9, 'Venusaur', 'Base Set', '15/102', 'card', null),
  (20, 10, 10, 'Alakazam', 'Fossil', '1/62', 'card', 'https://cdn/20.webp');
insert into public.marketplace_search_candidates values (10, '4/102', 'Holo Rare', 'Pokemon'),
  (20, '1/62', 'Holo Rare', 'Pokemon');
insert into public.pokoin_pokemon_expansions values ('Base Set', 'https://cdn/base.svg');
insert into public.marketplace_card_urls values (10, 'en', '/marketplace/en/cards/10/charizard');
insert into public.marketplace_user_listings
  (card_id, status, price_pkn, quantity_available, shipping_available, nft_available, graded, grading_company, grade) values
  ('10', 'active', 900, 1, true, false, true, 'PSA', '10'),
  ('10', 'active', 500, 2, true, false, true, 'BGS', '9.5'),
  ('10', 'active', 100, 5, true, false, false, '', ''),
  ('12', 'sold_out', 400, 0, true, false, true, 'PSA', '9'),
  ('14', 'active', 50, 3, true, false, false, '', ''),
  ('16', 'active', 700, 1, false, true, true, 'CGC', '9'),
  ('18', 'active', 800, 1, true, false, true, 'PSA', '8'),
  ('20', 'active', 300, 1, true, false, true, 'CGC', '8'),
  ('ct:abc', 'active', 300, 1, true, false, true, 'PSA', '7');
";

fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Every plan node that reads `relation`, with its actual loop count.
fn relation_loops(plan: &Value, relation: &str, out: &mut Vec<i64>) {
    if plan["Relation Name"].as_str() == Some(relation) {
        out.push(plan["Actual Loops"].as_i64().unwrap_or(-1));
    }
    for child in plan["Plans"].as_array().into_iter().flatten() {
        relation_loops(child, relation, out);
    }
}

#[tokio::test]
async fn graded_versions_list_graded_cards_and_scan_the_listings_once() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("test database");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");

    let args = RowsForVersionsArgs {
        product_category: "graded".into(),
        limit: 48,
        ..Default::default()
    };
    let rows = rows_for_versions(&pool, &args)
        .await
        .expect("graded versions");
    let ids: Vec<String> = rows.iter().map(|row| text(&row["card_id"])).collect();
    // Sold-out, ungraded, NFT-only, imageless and non-numeric listings drop out.
    assert_eq!(ids, vec!["10", "20"], "{rows:#?}");

    let charizard = &rows[0];
    assert_eq!(charizard["is_graded"], Value::Bool(true));
    assert_eq!(text(&charizard["graded_listing_count"]), "2");
    assert_eq!(text(&charizard["listed_quantity"]), "3");
    assert_eq!(text(&charizard["graded_lowest_price_pkn"]), "500");
    assert_eq!(text(&charizard["lowest_price_pkn"]), "500");
    assert_eq!(text(&charizard["grading_company"]), "BGS");
    assert_eq!(text(&charizard["grade"]), "9.5");
    assert_eq!(
        text(&charizard["homepage_cheapest_source"]),
        "marketplace_user_listings_graded"
    );
    assert_eq!(
        text(&charizard["homepage_cheapest_provider"]),
        "pokoin_native"
    );
    assert_eq!(
        text(&charizard["canonical_path"]),
        "/marketplace/en/cards/10/charizard"
    );
    assert_eq!(
        text(&charizard["expansion_symbol_url"]),
        "https://cdn/base.svg"
    );
    assert_eq!(text(&rows[1]["grading_company"]), "CGC");

    // Many versions and many ungraded listings: the listings are still read once.
    sqlx::raw_sql(
        "
        insert into public.marketplace_card_versions (card_id, ct_id, blueprint_id, name, expansion_name, expansion_number, product_type, preview_image_url)
        select 1000 + n * 2, 500 + n, 500 + n, 'Card ' || n, 'Set ' || (n % 40), (n % 200) || '/200', 'card', 'https://cdn/' || n || '.webp'
        from generate_series(1, 20000) n;
        insert into public.marketplace_user_listings (card_id, price_pkn, quantity_available)
        select (1000 + (n % 20000) * 2)::text, 10 + n % 90, 1
        from generate_series(1, 4000) n;
        analyze;
        ",
    )
    .execute(&pool)
    .await
    .expect("bulk rows");

    let started = Instant::now();
    let rows = rows_for_versions(&pool, &args)
        .await
        .expect("graded versions after bulk");
    let elapsed = started.elapsed();
    let ids: Vec<String> = rows.iter().map(|row| text(&row["card_id"])).collect();
    assert_eq!(ids, vec!["10", "20"]);

    let (sql, values) = rows_for_versions_sql(&args, "");
    let explain_sql = format!("explain (analyze, format json) {sql}");
    let mut explain = sqlx::query(&explain_sql);
    for value in &values {
        explain = match value {
            SqlParam::Text(text) => explain.bind(text.clone()),
            SqlParam::Int(n) => explain.bind(*n),
        };
    }
    let plan: Value = explain.fetch_one(&pool).await.expect("explain").get(0);
    let mut loops = Vec::new();
    relation_loops(&plan[0]["Plan"], "marketplace_user_listings", &mut loops);
    assert_eq!(loops, vec![1], "listings must be scanned once: {plan:#}");
    eprintln!("graded versions over 20k versions / 4k listings: {elapsed:?}");
}
