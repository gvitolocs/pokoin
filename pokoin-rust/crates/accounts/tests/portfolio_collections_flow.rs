//! A wishlist of four cards, priced on real Postgres by the market rather than by
//! what the seller happens to own.
//!
//! ```text
//! docker run -d --rm --name pokoin-portfolio-collections-test-pg \
//!   -e POSTGRES_PASSWORD=test -p 127.0.0.1:55478:5432 \
//!   --tmpfs /var/lib/postgresql/data postgres:17-alpine
//! POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55478/postgres \
//!   cargo test -p pokoin-accounts --test portfolio_collections_flow
//! ```
//!
//! Without `POKOIN_TEST_DATABASE_URL` the test is skipped; the CI `flow-db` job runs
//! it alone in a fresh database, which is why it creates every table the queries read
//! and drops them again at the end. It drives the real router over a scripted
//! Firestore, so the HTTP hop, the Postgres reads and the stored write are the
//! production ones.
//!
//! Only three tables are created here, and the two the main graph reads a seller's
//! stock from — `marketplace_user_listings` and `marketplace_cardtrader_1dr_assets` —
//! are deliberately **not** among them. A collection is a wishlist: it prices the
//! cards it names out of the market, and a route that went looking for the seller's
//! own stock would fail on a missing table in here rather than quietly answer a
//! basket of what they happen to own.
//!
//! The Pokémon catalog is the trap: it claims a 1000 PKN Base Set blueprint for the
//! Riftbound card's public id, because a card id is only unique inside its own
//! game's database. Every value below is what that game's catalog and sold book
//! reported, never what the collision would have priced.
//!
//! This binary holds exactly one test: a game's database comes from the process
//! environment, which the tests of one binary would race on.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
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
const COLLECTION: &str = "portfolio_collections";

/// The day the series is drawn for. Fixed, so the six days below and the sold prices
/// in the fixture always line up.
const TODAY: &str = "2026-10-08T12:00:00Z";

/// The two copies of the Pokémon single: 12 PKN from the 3rd, 10 PKN from the 6th.
/// Nothing after the 6th sold, so the last three days carry that price forward.
const RAW_FROM_THIRD: f64 = 12.0;
const RAW_FROM_SIXTH: f64 = 10.0;
const RAW_QTY: f64 = 2.0;
/// The graded slab of the same card, sold once on the 4th.
const GRADED: f64 = 200.0;
/// Riftbound's own price for its card, from the 5th.
const RIFT: f64 = 40.0;
/// What a Pokémon blueprint of the same public id sold for — the price no line
/// below is allowed to show.
const COLLISION: f64 = 1000.0;

const DROP_SQL: &str = "
drop table if exists
  public.marketplace_search_candidates,
  public.cardtrader_sold_daily,
  public.marketplace_card_versions cascade;
";

/// The three tables the route reads, in the live column names and types: the Pokémon
/// catalog by public card id, the sold book, and a game's own candidate catalog.
/// `card_id` is **bigint** in both catalogs, which is what makes the two games' ids
/// collide, and the sold book is shared because this throwaway database stands in
/// for Riftbound's as well.
const SCHEMA: &str = "
create table public.marketplace_card_versions (
  card_id bigint primary key, ct_id bigint unique, blueprint_id bigint, name text not null,
  expansion_name text not null, expansion_number text, product_variant text, image_url text,
  cdn_image_url text, preview_image_url text, homepage_image_url text, product_type text,
  trainer_name text, card_palette jsonb, emoji text, projected_at timestamptz default now());
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

/// Two Pokémon printings, one of them sold twice and graded once, a Riftbound card
/// and the pricey Pokémon blueprint its id collides with. CardTrader writes its sold
/// medians under `Near Mint` / `en`, and a collection item with no language named is
/// stored as that same English slice: one key, which is what prices a card at all.
const FIXTURES: &str = "
insert into public.marketplace_card_versions
  (card_id, blueprint_id, name, expansion_name, product_type) values
  (2001, 200, 'Pikachu', 'Scarlet & Violet 151', 'card'),
  (2002, 201, 'Charizard ex', 'Scarlet & Violet 151', 'card'),
  -- The Pokémon side of the collision: the catalog really does know a 1000 PKN
  -- printing for the card id Riftbound uses, and it is the one place in here where
  -- that number exists.
  (9001, 999, 'Charizard', 'Base Set', 'card');

insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty) values
  (200, '2026-10-03', 'Near Mint', 'en', 12, 11, 13, 4),
  (200, '2026-10-06', 'Near Mint', 'en', 10, 9, 11, 6),
  (999, '2026-10-02', 'Near Mint', 'en', 1000, 980, 1020, 1);
insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, graded, median_pkn, min_pkn, max_pkn, sold_qty) values
  (200, '2026-10-04', 'Near Mint', 'en', true, 200, 190, 210, 2);
-- Blueprint 201 (card 2002) has never sold: it belongs to a listing the seller made,
-- not to a market trade, and a listing is not a sale.

-- Riftbound's own database, same tables: its catalog names its blueprint and its
-- sold book prices it. Nothing here can be reached from the Pokémon catalog.
insert into public.marketplace_search_candidates
  (card_id, ct_id, name, set_name, expansion_name, product_type) values
  (9001, 777, 'Caitlyn, Sheriff of Piltover', 'Dawn of a New Era', 'dawn-of-a-new-era', 'card');
insert into public.cardtrader_sold_daily
  (blueprint_id, observed_day, condition, language, median_pkn, min_pkn, max_pkn, sold_qty) values
  (777, '2026-10-05', 'Near Mint', 'en', 40, 38, 45, 3);
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

/// Firestore documents by store key, as the typed wire shape.
type Store = Arc<Mutex<HashMap<String, Json>>>;

/// The store key of a resource name, in either form the client uses: the REST
/// `…/documents/<path>` name a commit carries, or the plain `<path>` of a seed.
fn key_of(name: &str) -> String {
    name.rsplit("/documents/")
        .next()
        .unwrap_or(name)
        .trim_matches('/')
        .to_string()
}

/// A Firestore that holds what it was told, so the list a save answers with is the
/// list the next read finds.
fn script_firestore() -> (pokoin_accounts::state::DomainState, Store) {
    let store: Store = Arc::new(Mutex::new(HashMap::new()));
    let transport = ScriptedTransport::new();

    let queries = store.clone();
    transport.on(":runQuery", move |request| {
        let asked: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let wanted = asked["structuredQuery"]["where"]["fieldFilter"]["value"]["stringValue"]
            .as_str()
            .unwrap_or_default();
        let documents: Vec<Json> = queries
            .lock()
            .unwrap()
            .values()
            .filter(|document| document["fields"]["uid"]["stringValue"].as_str() == Some(wanted))
            .map(|document| json!({ "document": document }))
            .collect();
        HttpResponse::json(200, Json::Array(documents))
    });
    let writes = store.clone();
    transport.on(":commit", move |request| {
        let body: Json = serde_json::from_slice(&request.body).unwrap_or(Json::Null);
        let mut store = writes.lock().unwrap();
        let mut results = Vec::new();
        for write in body["writes"].as_array().cloned().unwrap_or_default() {
            if let Some(name) = write["delete"].as_str() {
                store.remove(&key_of(name));
            } else if let Some(update) = write["update"].as_object() {
                let name = update["name"].as_str().unwrap_or_default().to_string();
                let key = key_of(&name);
                store.insert(key, json!({ "name": name, "fields": update["fields"] }));
            }
            results.push(json!({}));
        }
        HttpResponse::json(200, json!({ "writeResults": results }))
    });

    (test_state(&transport), store)
}

async fn write(app: &axum::Router, action: &str, body: Json, token: &str) -> (StatusCode, Json) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "/api/marketplace-portfolio-collections?action={action}"
        ))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("a test request is well formed");
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the router answers");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the body reads")
        .to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Json::Null))
}

/// `[valuePkn, cardsPriced, cardsHeld]` of one collection of one day.
fn segment(day: &Json, key: &str) -> Vec<f64> {
    day["segments"][key]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|value| value.as_f64().unwrap_or_default())
        .collect()
}

fn days_of(body: &Json) -> Vec<Json> {
    body["days"].as_array().cloned().unwrap_or_default()
}

fn day(body: &Json, date: &str) -> Json {
    days_of(body)
        .into_iter()
        .find(|day| day["date"] == json!(date))
        .unwrap_or(Json::Null)
}

fn item(answer: &Json, position: usize) -> Json {
    answer["collections"][0]["items"][position].clone()
}

/// What one card of the first list answers as its price, or nothing when its slice
/// has never traded.
fn price_of(answer: &Json, position: usize) -> Option<f64> {
    item(answer, position)["pricePkn"].as_f64()
}

/// Everything the route must answer for this seller, run apart from the setup so
/// the tables it reads are dropped whichever way the assertions go.
async fn price_a_wishlist(app: &axum::Router, token: &str, store: &Store) {
    let (status, wishlist) = write(
        app,
        "save",
        json!({
            "name": "Tournament legal",
            "items": [
                { "game": "pokemon", "cardId": "2001", "quantity": 2 },
                { "game": "pokemon", "cardId": "2001", "graded": true },
                { "game": "pokemon", "cardId": "2002" },
                { "game": "riftbound", "cardId": "9001" },
            ],
        }),
        token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={wishlist}");
    let first = wishlist["saved"].as_str().unwrap_or_default().to_string();
    assert!(!first.is_empty(), "body={wishlist}");

    // Six days, from the first trade of any slice in the list to today. A collection
    // keeps no acquisition date, so every card is held from the first day: that is
    // the backtest.
    let days = days_of(&wishlist);
    let dates: Vec<&str> = days.iter().filter_map(|day| day["date"].as_str()).collect();
    assert_eq!(
        dates,
        vec![
            "2026-10-03",
            "2026-10-04",
            "2026-10-05",
            "2026-10-06",
            "2026-10-07",
            "2026-10-08"
        ],
        "body={wishlist}"
    );
    let key = format!("collection:{first}");
    assert_eq!(
        segment(&day(&wishlist, "2026-10-03"), &key),
        vec![RAW_FROM_THIRD * RAW_QTY, 2.0, 5.0],
        "only the two raw copies have sold by the 3rd"
    );
    assert_eq!(
        segment(&day(&wishlist, "2026-10-04"), &key),
        vec![RAW_FROM_THIRD * RAW_QTY + GRADED, 3.0, 5.0],
        "the slab joins on the day its own facet last sold"
    );
    assert_eq!(
        segment(&day(&wishlist, "2026-10-05"), &key),
        vec![RAW_FROM_THIRD * RAW_QTY + GRADED + RIFT, 4.0, 5.0],
        "and Riftbound on its, out of its own database"
    );
    for date in ["2026-10-06", "2026-10-07", "2026-10-08"] {
        assert_eq!(
            segment(&day(&wishlist, date), &key),
            vec![RAW_FROM_SIXTH * RAW_QTY + GRADED + RIFT, 4.0, 5.0],
            "{date}: the 6th's 10 PKN carries forward, and nothing sold since"
        );
    }
    assert_ne!(
        segment(&day(&wishlist, "2026-10-08"), &key)[0],
        RAW_FROM_SIXTH * RAW_QTY + GRADED + COLLISION,
        "the Pokémon blueprint the Riftbound card id collides with priced nothing"
    );

    // Each card answers its own price as of the last day: the two facets of one card
    // apart, the never-sold card unpriced rather than zero, and the other game's card
    // at its own game's median.
    assert_eq!(price_of(&wishlist, 0), Some(RAW_FROM_SIXTH));
    assert_eq!(item(&wishlist, 0)["quantity"], json!(2));
    assert_eq!(price_of(&wishlist, 1), Some(GRADED));
    assert_eq!(item(&wishlist, 1)["graded"], json!(true));
    assert_eq!(
        price_of(&wishlist, 2),
        None,
        "a card the market never traded is unpriced, not free"
    );
    assert_eq!(item(&wishlist, 2)["quantity"], json!(1));
    assert_eq!(price_of(&wishlist, 3), Some(RIFT));
    assert_eq!(item(&wishlist, 3)["game"], json!("riftbound"));
    assert_eq!(
        item(&wishlist, 3)["setName"],
        json!(""),
        "the list shows what the seller wrote, not what a catalog guessed"
    );

    // A second list prices the same card on its own, and shares the window: a card
    // whose slice has not traded yet is held at nothing from the first day.
    let (status, both) = write(
        app,
        "save",
        json!({ "name": "One Riftbound card", "items": [ { "game": "riftbound", "cardId": "9001" } ] }),
        token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body={both}");
    let second = both["saved"].as_str().unwrap_or_default().to_string();
    assert_eq!(
        both["segmentDefs"],
        json!([
            { "key": key, "group": "collection", "label": "Tournament legal" },
            { "key": format!("collection:{second}"), "group": "collection", "label": "One Riftbound card" },
        ]),
        "one def per list, oldest first"
    );
    let single = format!("collection:{second}");
    assert_eq!(
        segment(&day(&both, "2026-10-03"), &single),
        vec![0.0, 0.0, 1.0]
    );
    assert_eq!(
        segment(&day(&both, "2026-10-04"), &single),
        vec![0.0, 0.0, 1.0]
    );
    for date in ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"] {
        assert_eq!(
            segment(&day(&both, date), &single),
            vec![RIFT, 1.0, 1.0],
            "{date}"
        );
    }
    assert_eq!(
        segment(&day(&both, "2026-10-08"), &key),
        vec![RAW_FROM_SIXTH * RAW_QTY + GRADED + RIFT, 4.0, 5.0],
        "the first list is unchanged by the second: five cards held, not six"
    );

    // A plain read answers the same series the write just did.
    let request = Request::builder()
        .method(Method::GET)
        .uri("/api/marketplace-portfolio-collections")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("a test request is well formed");
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the router answers");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("the body reads")
        .to_bytes();
    let read: Json = serde_json::from_slice(&bytes).unwrap_or(Json::Null);
    assert_eq!(
        read["days"], both["days"],
        "a read recomputes the same series"
    );
    assert_eq!(read["saved"], Json::Null, "only a write names one");

    // What was actually stored is the list and nothing else: no price, no blueprint,
    // no day, and no card of another game under a Pokémon blueprint. The market answer is recomputed on every read, so a stored copy could
    // only ever be out of date.
    let commits = store_commit_bodies(store, &first, &second);
    assert_eq!(commits.len(), 2, "one document per list");
    for (id, fields) in commits {
        let keys: Vec<&String> = fields
            .as_object()
            .map(|map| map.keys().collect())
            .unwrap_or_default();
        assert_eq!(
            keys,
            ["uid", "name", "items", "createdAt", "updatedAt"],
            "{id}"
        );
        let values = fields["items"]["arrayValue"]["values"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            values.len(),
            if id == first { 4 } else { 1 },
            "{id} lost or gained a card"
        );
        let stored = serde_json::to_string(&fields).unwrap_or_default();
        for leak in [
            "pricePkn",
            "blueprint",
            "median",
            "days",
            "segments",
            "1000",
            "999",
        ] {
            assert!(!stored.contains(leak), "{id} stored {leak}: {stored}");
        }
    }
}

#[tokio::test]
async fn a_wishlist_is_priced_by_the_market_not_by_what_the_seller_owns() {
    let Ok(url) = std::env::var("POKOIN_TEST_DATABASE_URL") else {
        eprintln!("skipped: POKOIN_TEST_DATABASE_URL is not set");
        return;
    };

    // Riftbound reads this database. No primary URL either, so a game with no env of
    // its own fails at once instead of deriving a path of this server that does not
    // exist.
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
    for sql in [DROP_SQL, SCHEMA, FIXTURES] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|error| panic!("the fixture is applied: {error}"));
    }

    let (state, store) = script_firestore();
    let state = state
        .with_marketplace_db(Some(MarketplaceDb::from_pool(pool.clone())))
        .with_clock(Arc::new(Frozen));
    let app = router(state);
    let token = sign_id_token(id_token_claims(
        SELLER,
        "ash@pokoin.com",
        chrono::Utc::now().timestamp(),
    ));

    // The assertions run in a task of their own, so a failed one still leaves this
    // database as it found it: the three tables it made are the same names the other
    // flow binaries use.
    let checked = {
        let app = app.clone();
        let token = token.clone();
        let store = store.clone();
        tokio::spawn(async move { price_a_wishlist(&app, &token, &store).await }).await
    };
    if let Err(error) = sqlx::raw_sql(DROP_SQL).execute(&pool).await {
        eprintln!("the throwaway tables are left behind: {error}");
    }
    pool.close().await;
    checked.expect("the wishlist assertions ran, whatever they concluded");
}

/// The typed `fields` of each collection document the test wrote, by id.
fn store_commit_bodies(store: &Store, first: &str, second: &str) -> Vec<(String, Json)> {
    [first, second]
        .into_iter()
        .filter_map(|id| {
            store
                .lock()
                .unwrap()
                .get(&format!("{COLLECTION}/{id}"))
                .map(|document| (id.to_string(), document["fields"].clone()))
        })
        .collect()
}
