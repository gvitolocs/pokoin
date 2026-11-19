//! One seller whose stored graph stops at the day the other games began to be
//! priced: the past days gain their Riftbound cards once, and a second visit does
//! not gain them again.
//!
//! ```text
//! docker run -d --rm --name pokoin-portfolio-backfill-test-pg \
//!   -e POSTGRES_PASSWORD=test -p 127.0.0.1:55491:5432 \
//!   --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres \
//!   cargo test -p pokoin-accounts --test portfolio_backfill_flow
//! docker rm -f pokoin-portfolio-backfill-test-pg
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped; the CI `flow-db` job
//! runs it alone in a fresh database, which is why it creates every table the
//! queries read — and drops them first, so a panic leaves nothing for the next run
//! to trip over.
//!
//! The scripted Firestore is a *document store*, not a recording: the write the
//! first request's refresh makes is what the second request reads back, with
//! Firestore's own `createTime` beside it. That is what lets this cover the whole
//! defect — a series stored before the deploy, and the two visits that follow it.
//!
//! The refresh runs behind the response, so each write is awaited on a permit the
//! fake hands out when it stores a document and which the wait spends; nothing here
//! waits on a clock. The second visit belongs to a second seller with the same rows
//! and the same stored document, because the in-flight refresh guard is per uid and
//! per process: one uid's two refreshes would race each other, not the marker.
//!
//! This binary holds exactly one test: a game's database comes from the process
//! environment, which the tests of one binary would race on.

mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

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

/// The seller the stored series belongs to, and the one the second visit is made
/// as. Their holdings are the same rows, so the same document content plans the
/// same way for both.
const SELLER: &str = "user-1";
const REVISITOR: &str = "user-2";

/// Noon on the 20th: two days after the deploy day, so every day of a stored
/// series is a past day. The second visit reads the clock [`HOUR`] / 3 later,
/// which puts the stored `updatedAt` outside the fresh window.
const TODAY: &str = "2026-11-20T12:00:00Z";
const HOUR: i64 = 60 * 60 * 1000;

/// The document Firestore says was created on the 1st of October — before the
/// deploy — which is what makes its past days eligible for the backfill.
const CREATED: &str = "2026-10-01T00:00:00Z";

/// Pokémon: two singles, priced by the Pokémon sold book on both sides of the
/// deploy.
const POKEMON_CHARIZARD: f64 = 20.0;
const POKEMON_PIKACHU: f64 = 30.0;
/// The Pokémon-only value the frozen days were stored with.
const POKEMON: f64 = POKEMON_CHARIZARD + POKEMON_PIKACHU;

/// Riftbound, priced only by Riftbound's own database: one card held since the
/// 10th, one since the 12th.
const RIFT_DAWN: f64 = 40.0;
const RIFT_OUTCAST: f64 = 10.0;
const RIFTBOUND: f64 = RIFT_DAWN + RIFT_OUTCAST;
/// Every day from the 12th on, when both games' cards were held and priced.
const BOTH: f64 = POKEMON + RIFTBOUND;

/// What the Pokémon blueprint those Riftbound card ids collide with sold for. No
/// day below moves it.
const COLLISION: f64 = 1000.0;

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
create table public.pokoin_pokemon_blueprints (id bigint primary key, expansion_id integer);
create table public.pokoin_pokemon_expansions (
  expansion_id bigint primary key, official_id text not null default '');
create table public.cardtrader_sold_daily (
  blueprint_id bigint not null,
  observed_day date not null,
  condition text not null default 'Near Mint',
  language text not null default 'en',
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

/// Two Pokémon listings and two Riftbound ones, every one of them priced by a sale
/// on the 9th. The Pokémon catalog claims the pricey blueprint 999 for both
/// Riftbound card ids, which is the collision the seller's own game has to win.
const FIXTURES: &str = "
insert into public.pokoin_pokemon_expansions (expansion_id, official_id) values
  (10, 'sv1'), (11, 'base1');
insert into public.pokoin_pokemon_blueprints (id, expansion_id) values
  (100, 10), (101, 11), (999, 11);
insert into public.marketplace_card_versions
  (card_id, blueprint_id, name, expansion_name, product_type) values
  (1001, 100, 'Pikachu', 'Scarlet & Violet 151', 'card'),
  (1002, 101, 'Charizard', 'Base Set', 'card'),
  (9001, 999, 'Charizard', 'Base Set', 'card'),
  (9002, 999, 'Charizard', 'Base Set', 'card');

-- Both sellers list the same four cards: two Pokémon on the 10th, one Riftbound on
-- the 10th and one on the 12th.
insert into public.marketplace_user_listings
  (card_id, seller_uid, price_pkn, quantity_available, created_at) values
  ('1001', 'user-1', 33, 1, '2026-11-10T09:00:00+00'),
  ('1002', 'user-1', 22, 1, '2026-11-10T09:00:00+00');
insert into public.marketplace_user_listings
  (card_id, seller_uid, marketplace_game, price_pkn, quantity_available, created_at) values
  ('9001', 'user-1', 'riftbound', 44, 1, '2026-11-10T09:00:00+00'),
  ('9002', 'user-1', 'riftbound', 11, 1, '2026-11-12T09:00:00+00');
insert into public.marketplace_user_listings
  (card_id, seller_uid, marketplace_game, price_pkn, quantity_available, created_at)
  select card_id, 'user-2', marketplace_game, price_pkn, quantity_available, created_at
    from public.marketplace_user_listings where seller_uid = 'user-1';

insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty) values
  (100, '2026-11-09', 'Near Mint', 'en', 30, 28, 33, 3),
  (101, '2026-11-09', 'Near Mint', 'en', 20, 18, 22, 5),
  (999, '2026-11-09', 'Near Mint', 'en', 1000, 980, 1020, 1);

-- Riftbound's own database: its catalog names the blueprint and the set, and its
-- sold book prices that blueprint.
insert into public.marketplace_search_candidates
  (card_id, ct_id, name, set_name, expansion_name, product_type) values
  (9001, 777, 'Caitlyn, Sheriff of Piltover', 'Dawn of a New Era', 'dawn-of-a-new-era', 'card'),
  (9002, 778, 'Jinx, the Undertow', 'Outcast', 'outcast', 'card');
insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty) values
  (777, '2026-11-09', 'Near Mint', 'en', 40, 38, 45, 3),
  (778, '2026-11-09', 'Near Mint', 'en', 10, 9, 12, 9);
";

/// A clock the test advances, so the second visit is a later one.
struct Now(AtomicI64);

impl Now {
    fn at(instant: &str) -> Self {
        Self(AtomicI64::new(
            chrono::DateTime::parse_from_rfc3339(instant)
                .expect("the test day is an instant")
                .timestamp_millis(),
        ))
    }
}

impl Clock for Now {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp_millis(self.0.load(Ordering::SeqCst))
            .expect("the clock holds an instant")
    }
}

/// Plain JSON as a Firestore typed value.
fn typed(value: &Json) -> Json {
    match value {
        Json::Null => json!({ "nullValue": null }),
        Json::Bool(value) => json!({ "booleanValue": value }),
        Json::Number(number) => {
            if let Some(integer) = number.as_i64() {
                json!({ "integerValue": integer.to_string() })
            } else {
                json!({ "doubleValue": number.as_f64() })
            }
        }
        Json::String(value) => json!({ "stringValue": value }),
        Json::Array(items) => json!({
            "arrayValue": { "values": items.iter().map(typed).collect::<Vec<_>>() }
        }),
        Json::Object(map) => json!({
            "mapValue": {
                "fields": map
                    .iter()
                    .map(|(key, value)| (key.clone(), typed(value)))
                    .collect::<serde_json::Map<_, _>>()
            }
        }),
    }
}

/// A Firestore typed value back as plain JSON, the way `to_plain_json` reads it.
fn plain(value: &Json) -> Json {
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    for key in ["stringValue", "referenceValue"] {
        if let Some(text) = map.get(key) {
            return text.clone();
        }
    }
    if let Some(text) = map.get("booleanValue") {
        return text.clone();
    }
    // Firestore writes both numbers as strings.
    if let Some(text) = map.get("integerValue").and_then(Json::as_str) {
        return text
            .parse::<i64>()
            .map(|value| json!(value))
            .unwrap_or(Json::Null);
    }
    if let Some(number) = map.get("doubleValue") {
        if let Some(text) = number.as_str() {
            return text
                .parse::<f64>()
                .map(|value| json!(value))
                .unwrap_or(Json::Null);
        }
        return number.clone();
    }
    if let Some(items) = map
        .get("arrayValue")
        .and_then(|array| array.get("values"))
        .and_then(Json::as_array)
    {
        return Json::Array(items.iter().map(plain).collect());
    }
    if let Some(fields) = map
        .get("mapValue")
        .and_then(|map| map.get("fields"))
        .and_then(Json::as_object)
    {
        return Json::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), plain(value)))
                .collect(),
        );
    }
    Json::Null
}

/// Firestore's `fields` map — field name to typed value — as plain JSON.
fn plain_fields(fields: &Json) -> Json {
    Json::Object(
        fields
            .as_object()
            .map(|map| {
                map.iter()
                    .map(|(key, value)| (key.clone(), plain(value)))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// A stored `portfolio_history` document with the shape the pre-deploy code wrote:
/// four past days, every one of them valued from Pokémon alone while all four
/// cards of the collection were already held.
fn pokemon_only_series() -> Json {
    let day = |date: &str, value: f64, priced: i64| {
        json!({
            "date": date, "currencyPkn": 0, "cardsValuePkn": value, "totalPkn": value,
            "cardsPriced": priced, "cardsHeld": 4, "cardsKnown": true, "cardsMove": 0,
        })
    };
    json!({
        "days": [
            day("2026-11-16", POKEMON, 2),
            day("2026-11-17", POKEMON, 2),
            // The deploy day: written by the old code, hours before it went live.
            day("2026-11-18", POKEMON, 2),
            // The next day belongs to the new code already, and is right.
            day("2026-11-19", BOTH, 4),
        ],
        "priceBasis": "ct-last-sold",
        "seriesRevision": 4,
        "segmentsRevision": 3,
        // Ten minutes old on a clock that reads noon: every freshness test passes,
        // so the only reason this visit recomputes is the missing coverage marker.
        "updatedAt": "2026-11-20T11:50:00.000Z",
    })
}

/// The document path a Firestore URL or a write's `update.name` points at.
fn document_path(url: &str) -> String {
    let rest = url
        .split_once("/documents")
        .map(|(_, rest)| rest)
        .unwrap_or("");
    rest.trim_start_matches('/')
        .trim_end_matches(":commit")
        .to_string()
}

/// A Firestore that stores documents: the write of one request is what the next
/// request reads, each with the `createTime` it was given and no write changes.
struct ScriptedFirestore {
    /// Document path → the two facts a read answers with, `createTime` and
    /// `fields` (the fields in Firestore's typed form).
    docs: Mutex<HashMap<String, Json>>,
    /// Every commit body, in order.
    commits: Mutex<Vec<Json>>,
    /// Handed one permit per stored document, so a test can await the write that
    /// runs behind a response without waiting on a clock.
    stored: tokio::sync::Semaphore,
}

impl ScriptedFirestore {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            docs: Mutex::new(HashMap::new()),
            commits: Mutex::new(Vec::new()),
            stored: tokio::sync::Semaphore::new(0),
        })
    }

    fn path(uid: &str) -> String {
        format!("portfolio_history/{uid}")
    }

    /// Stores a document as Firestore would have created it at `created_at`.
    fn seed(self: &Arc<Self>, uid: &str, fields: &Json, created_at: &str) {
        let fields = Json::Object(
            fields
                .as_object()
                .expect("a document is a map of fields")
                .iter()
                .map(|(key, value)| (key.clone(), typed(value)))
                .collect(),
        );
        self.docs.lock().unwrap().insert(
            Self::path(uid),
            json!({ "createTime": created_at, "fields": fields }),
        );
    }

    /// The plain fields a document holds now.
    fn fields(&self, uid: &str) -> Json {
        self.docs
            .lock()
            .unwrap()
            .get(&Self::path(uid))
            .map(|document| plain_fields(&document["fields"]))
            .unwrap_or_else(|| json!({ "missing": uid }))
    }

    /// Wait for the next document write. The timeout only fails fast when a write
    /// never comes at all; the signal itself is the permit.
    async fn await_stored(&self) {
        let wait = tokio::time::timeout(std::time::Duration::from_secs(60), self.stored.acquire());
        let permit = wait
            .await
            .expect("the refresh behind the response stores the series")
            .expect("the store is never closed");
        // A returned permit would be handed to the next wait as well: one write is
        // one wait, so this one is spent.
        permit.forget();
    }

    fn install(self: &Arc<Self>, transport: &Arc<ScriptedTransport>) {
        let store = self.clone();
        transport.on("documents:commit", move |request| {
            let Ok(body) = serde_json::from_slice::<Json>(&request.body) else {
                return HttpResponse::json(400, json!({ "error": { "message": "bad commit" } }));
            };
            let Some(update) = body["writes"][0]["update"].as_object() else {
                return HttpResponse::json(400, json!({ "error": { "message": "no update" } }));
            };
            let path = document_path(update["name"].as_str().unwrap_or_default());
            let fields = update["fields"].clone();
            let mut docs = store.docs.lock().unwrap();
            let document = docs.entry(path).or_insert_with(|| json!({ "fields": {} }));
            // A write replaces the fields and never moves the create time.
            document["fields"] = fields;
            drop(docs);
            store.commits.lock().unwrap().push(body.clone());
            store.stored.add_permits(1);
            HttpResponse::json(200, json!({ "writeResults": [{}] }))
        });

        let store = self.clone();
        transport.on_method("GET", "/portfolio_history/", move |request| {
            let path = document_path(&request.url);
            let document = store.docs.lock().unwrap().get(&path).cloned();
            match document {
                Some(document) => HttpResponse::json(
                    200,
                    json!({
                        "name": format!("projects/{TEST_PROJECT}/databases/(default)/documents/{path}"),
                        "createTime": document["createTime"],
                        "updateTime": "2026-11-19T09:00:00Z",
                        "fields": document["fields"],
                    }),
                ),
                None => HttpResponse::json(404, json!({ "error": { "code": 5 } })),
            }
        });

        // No ledger, no balance: the graph is the cards, and nothing else.
        transport.on(":runQuery", |_| HttpResponse::json(200, json!([])));
        transport.set_fallback(|_| HttpResponse::json(404, json!({ "error": { "code": 5 } })));
    }
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

/// The written days as `date → [valuePkn, cardsPriced, cardsHeld]`.
fn written_days(fields: &Json) -> Vec<(String, Vec<f64>)> {
    fields["days"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|day| {
            (
                day["date"].as_str().unwrap_or_default().to_string(),
                ["cardsValuePkn", "cardsPriced", "cardsHeld"]
                    .iter()
                    .map(|key| day[*key].as_f64().unwrap_or_default())
                    .collect(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_stored_series_gains_the_other_games_once() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };

    // Riftbound reads this database. No primary URL either, so a game with no env
    // of its own fails at once instead of deriving a path that does not exist.
    std::env::set_var("RIFTBOUND_MARKETPLACE_DATABASE_URL", &url);
    std::env::remove_var("MARKETPLACE_DATABASE_URL");
    std::env::remove_var("MARKETPLACE_PEER4_DATABASE_URL");

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
    let firestore = ScriptedFirestore::new();
    firestore.install(&transport);
    firestore.seed(SELLER, &pokemon_only_series(), CREATED);

    let clock = Arc::new(Now::at(TODAY));
    let state = test_state(&transport)
        .with_marketplace_db(Some(MarketplaceDb::from_pool(pool.clone())))
        .with_clock(clock.clone());
    let app = router(state);
    let now = chrono::Utc::now().timestamp();
    let token = sign_id_token(id_token_claims(SELLER, "ash@pokoin.com", now));

    // What the seller of DGRAPH-02 sees on the way in: the stored days answer at
    // once, and the line stops short on the 18th.
    let (status, body) = history(&app, &token).await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        written_days(&body),
        vec![
            ("2026-11-16".to_string(), vec![50.0, 2.0, 4.0]),
            ("2026-11-17".to_string(), vec![50.0, 2.0, 4.0]),
            ("2026-11-18".to_string(), vec![50.0, 2.0, 4.0]),
            ("2026-11-19".to_string(), vec![100.0, 4.0, 4.0]),
        ],
        "the stale answer is still the stored series"
    );

    // The write that runs behind it prices the past days out of Riftbound's own
    // database and marks the document.
    firestore.await_stored().await;
    let fields = firestore.fields(SELLER);
    assert_eq!(
        fields["gamesCoverage"],
        json!(1),
        "the document says its days carry every game"
    );
    assert_eq!(
        fields["priceBasis"],
        pokemon_only_series()["priceBasis"],
        "the marker travels with an unchanged basis"
    );
    assert_eq!(
        fields["seriesRevision"],
        pokemon_only_series()["seriesRevision"],
        "and an unchanged series revision, so no history is thrown away"
    );
    let raised = written_days(&fields);
    let expected: Vec<(String, Vec<f64>)> = [
        // Before the second Riftbound card was listed the day can only gain the
        // one card it held then.
        ("2026-11-10", vec![90.0, 3.0, 3.0]),
        ("2026-11-11", vec![90.0, 3.0, 3.0]),
        ("2026-11-12", vec![100.0, 4.0, 4.0]),
        ("2026-11-13", vec![100.0, 4.0, 4.0]),
        ("2026-11-14", vec![100.0, 4.0, 4.0]),
        ("2026-11-15", vec![100.0, 4.0, 4.0]),
        // The three days that were stored Pokémon-only, raised by the value of
        // the two Riftbound cards held on them.
        ("2026-11-16", vec![100.0, 4.0, 4.0]),
        ("2026-11-17", vec![100.0, 4.0, 4.0]),
        // The deploy day itself, raised because its own count still said Pokémon.
        ("2026-11-18", vec![100.0, 4.0, 4.0]),
        // The day the new code had already priced: untouched, and now in line.
        ("2026-11-19", vec![100.0, 4.0, 4.0]),
        ("2026-11-20", vec![100.0, 4.0, 4.0]),
    ]
    .into_iter()
    .map(|(date, values)| (date.to_string(), values))
    .collect();
    assert_eq!(raised, expected, "the graph is one line from the 12th on");
    for (date, values) in &raised {
        assert!(
            values[0] < COLLISION,
            "{date} is priced by a Pokémon blueprint it collides with: {values:?}"
        );
    }
    // What the document holds is the series and its marker. Firestore's own create
    // time is carried beside the JSON, never inside it.
    let mut names = fields
        .as_object()
        .map(|map| map.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    names.sort();
    assert_eq!(
        names,
        [
            "days",
            "gamesCoverage",
            "priceBasis",
            "segmentLabels",
            "segmentsRevision",
            "seriesRevision",
            "updatedAt",
        ],
        "the stored fields are exactly the series and the marker"
    );

    // A second seller, the same holdings, and the document the first write made —
    // read as an hour later, so this visit recomputes rather than serving fresh.
    firestore.seed(REVISITOR, &fields, CREATED);
    clock.0.fetch_add(HOUR / 3, Ordering::SeqCst);
    let token = sign_id_token(id_token_claims(REVISITOR, "mira@pokoin.com", now));
    let (status, body) = history(&app, &token).await;
    assert_eq!(status, StatusCode::OK, "body={body}");
    assert_eq!(
        written_days(&body),
        raised,
        "the revisit answers with the whole raised line, day for day"
    );

    firestore.await_stored().await;
    let again = firestore.fields(REVISITOR);
    assert_eq!(
        again["gamesCoverage"],
        json!(1),
        "the marker is written with every series"
    );
    assert_ne!(
        again["updatedAt"], fields["updatedAt"],
        "and this visit really did recompute and store"
    );
    assert_eq!(
        written_days(&again),
        raised,
        "a second recompute of the marked document changes no day: the other \
         games were added once, not on every request"
    );

    assert_eq!(
        firestore.commits.lock().unwrap().len(),
        2,
        "one write per visit, no more"
    );
    pool.close().await;
}
