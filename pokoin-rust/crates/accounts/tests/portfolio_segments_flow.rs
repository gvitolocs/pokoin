//! One seller who collects three games: every era band, every set, sealed and
//! graded — each card priced out of the database that actually knows it.
//!
//! ```text
//! docker run -d --rm --name pokoin-portfolio-segments-test-pg \
//!   -e POSTGRES_PASSWORD=test -p 127.0.0.1:55477:5432 \
//!   --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55477/postgres \
//!   cargo test -p pokoin-accounts --test portfolio_segments_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped; the CI `flow-db` job
//! runs it alone in a fresh database, which is why it creates every table the
//! three queries read. It drives the real router over a scripted Firestore, so
//! the HTTP hop, the Postgres reads and the stored write are the production ones.
//!
//! The Pokémon catalog is the trap in here: `marketplace_card_versions` knows a
//! pricey Pokémon blueprint for the Riftbound and Gundam card ids, because a
//! public card id is only unique inside its own game's database. Every value
//! below is what the game's own catalog and sold book reported, never what the
//! collision would have priced.
//!
//! This binary holds exactly one test: a game's database comes from the process
//! environment, which the tests of one binary would race on.

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use pokoin_accounts::http::HttpResponse;
use pokoin_accounts::router;
use pokoin_accounts::sql::MarketplaceDb;
use pokoin_accounts::state::Clock;
use serde_json::{json, Value as Json};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

const SELLER: &str = "user-1";

/// The day the series is drawn for. Fixed, so the three days below and the sold
/// prices in the fixture always line up; the cards were acquired on the 6th and
/// every slice last sold on the 5th.
const TODAY: &str = "2026-10-08T12:00:00Z";

/// Pokémon: two Scarlet & Violet singles (one of them two copies), a sealed box,
/// a vintage single from the 1-DR stock, and a graded slab.
const VINTAGE_1DR: f64 = 40.0;
const SV_SINGLE: f64 = 10.0;
const SV_BOX: f64 = 100.0;
const GRADED_SLAB: f64 = 200.0;
/// Three single copies of Scarlet & Violet printings (one of them listed twice)
/// and a sealed box, all in the Scarlet & Violet band.
const SV_SINGLES: f64 = SV_SINGLE * 3.0;
const POKEMON_SV: f64 = SV_SINGLES + SV_BOX;
const POKEMON_TOTAL: f64 = POKEMON_SV + VINTAGE_1DR + GRADED_SLAB;

/// Riftbound, priced by Riftbound's own database: one card of Dawn of a New Era,
/// one of Outcast, and one sealed box of Outcast.
const RIFT_DAWN: f64 = 40.0;
const RIFT_OUTCAST_SINGLE: f64 = 5.0;
const RIFT_OUTCAST_BOX: f64 = 30.0;
const RIFTBOUND_TOTAL: f64 = RIFT_DAWN + RIFT_OUTCAST_SINGLE + RIFT_OUTCAST_BOX;

/// What a Pokémon blueprint of the same public id sold for — the price no line
/// below is allowed to show.
const COLLISION: f64 = 1000.0;

/// Everything the three queries read, in the live column names and types: the
/// 1-DR table as `scripts/sql/091_cardtrader_one_day_ready_assets.sql` has it,
/// the listings as the other crates' flow schemas have them, the sold book as
/// `apps/cardtrader-sold/src/db.rs` creates it. `card_id` is **text** on a
/// holding and **bigint** in a catalog, which is why every join here casts.
///
/// The satellite tables (`marketplace_search_candidates`, `cardtrader_sold_daily`)
/// are what a game's own database holds; here they sit in this same throwaway
/// database, which the environment points Riftbound at.
const SCHEMA: &str = "
drop table if exists
  public.marketplace_cardtrader_1dr_assets,
  public.marketplace_user_listings,
  public.marketplace_card_versions,
  public.pokoin_pokemon_blueprints,
  public.pokoin_pokemon_expansions,
  public.cardtrader_sold_daily,
  public.marketplace_search_candidates cascade;
create table public.marketplace_cardtrader_1dr_assets (
  seller_uid text not null,
  ct_product_id text not null,
  blueprint_id text not null default '',
  card_id text not null default '',
  card_name text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  card_image_url text not null default '',
  condition text not null default '',
  language text not null default '',
  reverse boolean not null default false,
  first_edition boolean not null default false,
  signed boolean not null default false,
  altered boolean not null default false,
  graded boolean not null default false,
  quantity integer not null default 0 check (quantity >= 0 and quantity <= 999999),
  price_pkn numeric not null default 0 check (price_pkn >= 0),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (seller_uid, ct_product_id));
create table public.marketplace_user_listings (
  id uuid primary key default gen_random_uuid(),
  card_id text not null,
  seller_uid text not null,
  seller_name text not null default 'Pokoin seller',
  condition text not null default 'NM',
  language text not null default 'EN',
  price_pkn numeric not null check (price_pkn > 0),
  quantity_available integer not null default 1 check (quantity_available >= 0),
  signed boolean not null default false,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  foil_state text not null default 'standard',
  sealed boolean not null default false,
  graded boolean not null default false,
  grading_company text,
  grade text,
  certification_id text,
  seller_comment text not null default '',
  source text not null default 'pokoin_user_listing',
  source_listing_id text not null default '',
  status text not null default 'active'
    check (status in ('active', 'paused', 'inactive', 'sold_out')),
  card_name text not null default '',
  card_image_url text not null default '',
  set_name text not null default '',
  collector_number text not null default '',
  location text not null default '',
  altered boolean not null default false,
  marketplace_game text not null default 'pokemon',
  photo_urls text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create table public.marketplace_card_versions (
  card_id bigint primary key, ct_id bigint unique, blueprint_id bigint, name text not null,
  expansion_name text not null, expansion_number text, product_variant text, image_url text,
  cdn_image_url text, preview_image_url text, homepage_image_url text, product_type text,
  trainer_name text, card_palette jsonb, emoji text, projected_at timestamptz default now());
-- Only the two columns the holdings join walks.
create table public.pokoin_pokemon_blueprints (id bigint primary key, expansion_id integer);
create table public.pokoin_pokemon_expansions (
  expansion_id bigint primary key, official_id text not null default '');
create table public.cardtrader_sold_daily (
  blueprint_id bigint not null,
  observed_day date not null,
  condition text not null,
  language text not null,
  reverse boolean not null default false,
  first_edition boolean not null default false,
  graded boolean not null default false,
  median_pkn numeric not null,
  min_pkn numeric not null,
  max_pkn numeric not null,
  sold_qty integer not null default 0,
  listings integer not null default 0,
  graded_comments text[] not null default '{}'::text[],
  refreshed_at timestamptz not null default now(),
  sample_count integer not null default 0,
  primary key (blueprint_id, observed_day, condition, language, reverse, first_edition, graded));
create table public.marketplace_search_candidates (
  card_id bigint primary key, ct_id bigint not null, name text not null,
  set_name text not null default '', expansion_name text not null default '',
  item_kind text not null default 'single', product_type text not null default 'card',
  rarity text not null default 'Card', card_type text not null default 'Card',
  projected_at timestamptz not null default now());
";

/// Five Pokémon printings, three Riftbound listings, one Gundam listing. Every
/// slice last sold on the 5th and every card was acquired on the 6th, so the
/// three days of the series price the same basket.
///
/// CardTrader writes its sold medians under the names it is given (`Near Mint`,
/// `en`) while Pokoin stores `NM` / `EN` on a listing: the two meet on one slice
/// key, and that is what prices a card at all.
const FIXTURES: &str = "
insert into public.pokoin_pokemon_expansions (expansion_id, official_id) values
  (10, 'sv1'), (11, 'base1');
insert into public.pokoin_pokemon_blueprints (id, expansion_id) values
  (100, 10), (101, 10), (102, 10), (103, 11), (104, 11), (999, 11);

insert into public.marketplace_card_versions
  (card_id, blueprint_id, name, expansion_name, product_type) values
  (1001, 100, 'Pikachu', 'Scarlet & Violet 151', 'card'),
  (1002, 101, 'Charizard ex', 'Scarlet & Violet 151', 'card'),
  (1003, 102, 'Scarlet & Violet 151 Set', 'Scarlet & Violet 151', 'booster_box'),
  (1004, 103, 'Charizard', 'Base Set', 'card'),
  (1005, 104, 'Charizard', 'Base Set', 'card');
-- The Pokémon holdings: two Scarlet & Violet singles (one of them two copies)
-- and a sealed box as listings, a vintage single as 1-DR stock, a graded slab.
insert into public.marketplace_user_listings
  (card_id, seller_uid, price_pkn, quantity_available, created_at) values
  ('1001', 'user-1', 12, 1, '2026-10-06T12:00:00+00'),
  ('1002', 'user-1', 12, 2, '2026-10-06T12:00:00+00'),
  ('1003', 'user-1', 120, 1, '2026-10-06T12:00:00+00');
insert into public.marketplace_cardtrader_1dr_assets
  (seller_uid, ct_product_id, card_id, blueprint_id, condition, language, quantity, price_pkn, created_at) values
  ('user-1', 'ct-1004', '1004', '103', 'NM', 'EN', 1, 45, '2026-10-06T12:00:00+00');
insert into public.marketplace_user_listings
  (card_id, seller_uid, price_pkn, graded, quantity_available, created_at) values
  ('1005', 'user-1', 240, true, 1, '2026-10-06T12:00:00+00');

-- The other games. The Pokémon catalog claims a pricey vintage blueprint for
-- every one of these card ids; that is the collision the seller's own game has
-- to win, and its product type says a loose card even for the sealed box.
insert into public.marketplace_card_versions (card_id, blueprint_id, name, expansion_name) values
  (9001, 999, 'Charizard', 'Base Set'),
  (9002, 999, 'Charizard', 'Base Set'),
  (9003, 999, 'Charizard', 'Base Set'),
  (9004, 999, 'Charizard', 'Base Set');
insert into public.marketplace_user_listings
  (card_id, seller_uid, marketplace_game, price_pkn, quantity_available, created_at) values
  ('9001', 'user-1', 'riftbound', 45, 1, '2026-10-06T12:00:00+00'),
  ('9002', 'user-1', 'riftbound', 6, 1, '2026-10-06T12:00:00+00'),
  ('9004', 'user-1', 'riftbound', 35, 1, '2026-10-06T12:00:00+00'),
  ('9003', 'user-1', 'gundam', 7, 1, '2026-10-06T12:00:00+00');

insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty) values
  (100, '2026-10-05', 'Near Mint', 'en', 10, 9, 12, 3),
  (101, '2026-10-05', 'Near Mint', 'en', 10, 9, 11, 5),
  (102, '2026-10-05', 'Near Mint', 'en', 100, 95, 110, 2),
  (103, '2026-10-05', 'Near Mint', 'en', 40, 38, 44, 4),
  (999, '2026-10-05', 'Near Mint', 'en', 1000, 980, 1020, 1);
insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, graded, median_pkn, min_pkn, max_pkn, sold_qty) values
  (104, '2026-10-05', 'Near Mint', 'en', true, 200, 190, 210, 2);

-- Riftbound's own database: its catalog names the CardTrader blueprint, the set
-- and the product type, and its sold book prices that blueprint. Outcast is
-- named only in `set_name`, which is the column the catalog falls back to.
insert into public.marketplace_search_candidates
  (card_id, ct_id, name, set_name, expansion_name, product_type) values
  (9001, 777, 'Caitlyn, Sheriff of Piltover', 'Dawn of a New Era', 'Dawn of a New Era', 'card'),
  (9002, 778, 'Jinx, the Undertow', 'Outcast', '', 'card'),
  (9004, 779, 'Outcast Collector Booster', 'Outcast', '', 'booster_box');
insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty) values
  (777, '2026-10-05', 'Near Mint', 'en', 40, 38, 45, 3),
  (778, '2026-10-05', 'Near Mint', 'en', 5, 4, 6, 9),
  (779, '2026-10-05', 'Near Mint', 'en', 30, 28, 33, 2);
";

/// The series is drawn for a fixed day; the token still carries the real clock,
/// which is what the verifier checks it against.
struct Frozen;

impl Clock for Frozen {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(TODAY)
            .expect("the frozen day is an instant")
            .with_timezone(&chrono::Utc)
    }
}

/// `[valuePkn, cardsPriced, cardsHeld]` of one segment of one day.
fn segment(day: &Json, key: &str) -> Vec<f64> {
    day["segments"][key]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|value| value.as_f64().unwrap_or_default())
        .collect()
}

fn def_of(defs: &[Json], key: &str) -> Json {
    defs.iter()
        .find(|def| def["key"] == json!(key))
        .cloned()
        .unwrap_or(Json::Null)
}

/// `GET /api/marketplace-portfolio-history` through the real router.
async fn history(app: &axum::Router, token: &str) -> (StatusCode, Json) {
    let request = Request::builder()
        .method("GET")
        .uri("/api/marketplace-portfolio-history")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap_or_default();
    let response = app.clone().oneshot(request).await.unwrap_or_default();
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .map(|value| value.as_bytes()),
        Some("no-store".as_bytes()),
        "a recomputed series is never cacheable"
    );
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .unwrap_or_default();
    (status, serde_json::from_slice(&bytes).unwrap_or(Json::Null))
}

#[tokio::test]
async fn a_seller_who_plays_three_games_gets_a_line_for_each() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };

    // Riftbound reads this database; Gundam reads nothing, which is the case
    // that must leave its card held and unpriced. No primary URL either, so a
    // game with no env of its own fails at once instead of deriving a path of
    // this server that does not exist.
    std::env::set_var("RIFTBOUND_MARKETPLACE_DATABASE_URL", &url);
    std::env::remove_var("MARKETPLACE_DATABASE_URL");
    std::env::remove_var("MARKETPLACE_PEER4_DATABASE_URL");
    std::env::remove_var("GUNDAM_MARKETPLACE_DATABASE_URL");

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(20))
        .connect(&url)
        .await
        .expect("the throwaway database is reachable");
    for sql in [SCHEMA, FIXTURES] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|error| panic!("the fixture is applied: {error}"));
    }

    let transport = ScriptedTransport::new();
    transport.on("documents:commit", |_| {
        HttpResponse::json(200, json!({ "writeResults": [{}] }))
    });
    transport.on(":runQuery", |_| HttpResponse::json(200, json!([])));
    // Nothing stored yet, and no ledger either: the request computes the series.
    transport.set_fallback(|_| HttpResponse::json(404, json!({ "error": { "code": 5 } })));

    let state = test_state(&transport)
        .with_marketplace_db(Some(MarketplaceDb::from_pool(pool.clone())))
        .with_clock(Arc::new(Frozen));
    let app = router(state);
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims(SELLER, "ash@pokoin.com", now));

    let (status, body) = history(&app, &token).await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(body["ok"], json!(true), "body={body}");

    let days = body["days"].as_array().cloned().unwrap_or_default();
    // Acquired on the 6th, drawn for the 8th: three days, and the same basket
    // on each of them.
    let dates: Vec<&str> = days.iter().filter_map(|day| day["date"].as_str()).collect();
    assert_eq!(dates, vec!["2026-10-06", "2026-10-07", "2026-10-08"]);
    for day in &days {
        assert_eq!(
            day["cardsValuePkn"].as_f64(),
            Some(POKEMON_TOTAL + RIFTBOUND_TOTAL),
            "the total counts every game priced: {day}"
        );
    }
    let today = days.last().cloned().unwrap_or(Json::Null);

    // Every Pokémon line, in the era band its printing belongs to.
    assert_eq!(
        segment(&today, "game:pokemon"),
        vec![POKEMON_TOTAL, 6.0, 6.0]
    );
    assert_eq!(
        segment(&today, "pokemon:era:vintage"),
        vec![VINTAGE_1DR + GRADED_SLAB, 2.0, 2.0]
    );
    assert_eq!(
        segment(&today, "pokemon:era:sv"),
        vec![POKEMON_SV, 4.0, 4.0]
    );
    assert_eq!(today["segments"].get("pokemon:era:mid"), None);
    assert_eq!(segment(&today, "pokemon:sealed"), vec![SV_BOX, 1.0, 1.0]);
    assert_eq!(
        segment(&today, "pokemon:graded"),
        vec![GRADED_SLAB, 1.0, 1.0]
    );

    // Sealed and graded cut across the games: the Pokémon box and the Riftbound
    // box share all:sealed, and no Riftbound card is graded.
    assert_eq!(
        segment(&today, "all:sealed"),
        vec![SV_BOX + RIFT_OUTCAST_BOX, 2.0, 2.0]
    );
    assert_eq!(segment(&today, "all:graded"), vec![GRADED_SLAB, 1.0, 1.0]);

    // Riftbound is priced by Riftbound — 75 PKN, not the 3000 PKN the Pokémon
    // blueprints those card ids collide with would have said.
    assert_eq!(
        segment(&today, "game:riftbound"),
        vec![RIFTBOUND_TOTAL, 3.0, 3.0]
    );
    assert_eq!(
        segment(&today, "riftbound:set:dawn-of-a-new-era"),
        vec![RIFT_DAWN, 1.0, 1.0]
    );
    assert_eq!(
        segment(&today, "riftbound:set:outcast"),
        vec![RIFT_OUTCAST_SINGLE + RIFT_OUTCAST_BOX, 2.0, 2.0]
    );
    assert_eq!(
        segment(&today, "riftbound:sealed"),
        vec![RIFT_OUTCAST_BOX, 1.0, 1.0],
        "the game's own catalog said booster box, the Pokémon one said card"
    );
    assert_eq!(
        today["segments"].get("riftbound:graded"),
        None,
        "a segment with nothing held is not drawn"
    );
    assert!(
        today["segments"].get("riftbound:set:other").is_none(),
        "two sets of a game are both drawn, so nothing falls into other"
    );

    // The game with no database is held, priced at nothing, and does not touch
    // the games beside it.
    assert_eq!(segment(&today, "game:gundam"), vec![0.0, 0.0, 1.0]);
    assert_eq!(segment(&today, "gundam:set:unknown"), vec![0.0, 0.0, 1.0]);
    assert_ne!(
        segment(&today, "game:riftbound"),
        vec![COLLISION * 3.0, 3.0, 3.0],
        "the Pokémon blueprints those card ids collide with priced nothing"
    );

    // What the client draws: both other games, the cuts across every game, then
    // each game's own block — Pokémon by era, the others by their sets.
    let defs = body["segmentDefs"].as_array().cloned().unwrap_or_default();
    let keys: Vec<&str> = defs.iter().filter_map(|def| def["key"].as_str()).collect();
    assert_eq!(
        keys,
        vec![
            "game:pokemon",
            "game:gundam",
            "game:riftbound",
            "all:sealed",
            "all:graded",
            "pokemon:era:vintage",
            "pokemon:era:mid",
            "pokemon:era:xy",
            "pokemon:era:sm",
            "pokemon:era:swsh",
            "pokemon:era:sv",
            "pokemon:era:post-sv",
            "pokemon:era:other",
            "pokemon:sealed",
            "pokemon:graded",
            "gundam:set:unknown",
            "gundam:sealed",
            "gundam:graded",
            "riftbound:set:dawn-of-a-new-era",
            "riftbound:set:outcast",
            "riftbound:sealed",
            "riftbound:graded",
        ],
        "defs={keys:?}"
    );
    assert_eq!(
        def_of(&defs, "riftbound:set:dawn-of-a-new-era"),
        json!({
            "key": "riftbound:set:dawn-of-a-new-era",
            "group": "set",
            "game": "riftbound",
            "label": "Dawn of a New Era",
        }),
        "a set line carries the catalog's own name, not its slug"
    );
    assert_eq!(
        def_of(&defs, "gundam:set:unknown")["label"],
        json!("Unknown"),
        "an unnamed set is read back from its slug"
    );
    assert_eq!(
        def_of(&defs, "riftbound:graded"),
        json!({ "key": "riftbound:graded", "group": "type", "game": "riftbound", "label": "Graded" }),
        "every game is cut by type, held or not"
    );

    // The set names travel with the series, so a day frozen under this cut keeps
    // being labelled by it.
    let commits = transport.requests_to("documents:commit");
    assert_eq!(commits.len(), 1, "the recompute stores the series once");
    let written: Json = serde_json::from_slice(&commits[0].body).unwrap_or(Json::Null);
    let fields = written["writes"][0]["update"]["fields"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        fields["segmentsRevision"]["integerValue"],
        json!("3"),
        "the set cut is a new segments revision, so stored days are rebuilt"
    );
    let labels = &fields["segmentLabels"]["mapValue"]["fields"];
    assert_eq!(
        labels["riftbound:set:dawn-of-a-new-era"]["stringValue"],
        json!("Dawn of a New Era"),
        "labels={labels}"
    );
    assert_eq!(
        labels["riftbound:set:outcast"]["stringValue"],
        json!("Outcast"),
        "labels={labels}"
    );
    assert_eq!(
        labels.get("gundam:set:unknown"),
        None,
        "a set nobody named stores no label"
    );

    pool.close().await;
}
