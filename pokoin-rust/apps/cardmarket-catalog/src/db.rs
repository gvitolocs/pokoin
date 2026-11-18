//! Writer access (nezopt `pokoin-marketplace-postgres-15t`, published on
//! 127.0.0.1:25433). Tables: the game's raw `cardmarket_products`, the search
//! candidates, migration 112 (`marketplace_card_daily_median`) and 126
//! (`cardmarket_price_guide_daily`). No DDL here.

use std::collections::HashSet;

use sqlx::postgres::{PgConnectOptions, PgConnection, PgPoolOptions, PgSslMode};
use sqlx::{PgPool, Row};

use crate::cm_daily::{self, DailyOffer};
use crate::cm_offers::Minimum;
use crate::sources::PriceGuide;
use crate::tcgnotify::Ask;

/// A row of `<schema>.cardmarket_products`, with its public card id.
#[derive(Debug, Clone)]
pub struct Card {
    pub id: i64,
    pub key: String,
    pub source: String,
    pub name: String,
    pub set_name: String,
    pub set_code: String,
    pub collector: String,
    pub rarity: String,
    /// `fixed_properties.language` (Weiss Schwarz: `EN` or `JP`).
    pub language: String,
    pub card_market_ids: Vec<i64>,
    /// `marketplace_search_candidates.card_id`; `None` when not projected.
    pub card_id: Option<i64>,
}

pub fn credentials() -> Result<(String, String), String> {
    for (user_var, password_var) in [
        ("POKOIN_CARDMARKET_PG_USER", "POKOIN_CARDMARKET_PG_PASSWORD"),
        ("POSTGRES_USER", "POSTGRES_PASSWORD"),
    ] {
        if let (Ok(user), Ok(password)) = (std::env::var(user_var), std::env::var(password_var)) {
            if !user.is_empty() && !password.is_empty() {
                return Ok((user, password));
            }
        }
    }
    // The container's own login, as the Python importer uses (docker exec psql).
    let output = std::process::Command::new("docker")
        .args([
            "inspect",
            "pokoin-marketplace-postgres-15t",
            "--format",
            "{{json .Config.Env}}",
        ])
        .output()
        .map_err(|error| format!("docker inspect failed: {error}"))?;
    if !output.status.success() {
        return Err("set POKOIN_CARDMARKET_PG_USER/PASSWORD (docker inspect failed)".into());
    }
    let list: Vec<String> = serde_json::from_slice(&output.stdout)
        .map_err(|_| "docker inspect env is not a JSON list".to_string())?;
    let get = |name: &str| {
        list.iter()
            .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
            .map(str::to_string)
    };
    match (get("POSTGRES_USER"), get("POSTGRES_PASSWORD")) {
        (Some(user), Some(password)) if !password.is_empty() => Ok((user, password)),
        _ => Err("no POSTGRES_USER/POSTGRES_PASSWORD in the container env".into()),
    }
}

pub async fn connect(database: &str, read_only: bool) -> Result<PgPool, String> {
    let (user, password) = credentials()?;
    let port = match std::env::var("POKOIN_CARDMARKET_PG_PORT") {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse()
            .map_err(|_| "POKOIN_CARDMARKET_PG_PORT is not a port".to_string())?,
        _ => 25433,
    };
    let options = PgConnectOptions::new()
        .host("127.0.0.1")
        .port(port)
        .username(&user)
        .password(&password)
        .database(database)
        .ssl_mode(PgSslMode::Disable);
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .after_connect(move |conn, _| {
            Box::pin(async move {
                sqlx::query("set statement_timeout = '300s'")
                    .execute(&mut *conn)
                    .await?;
                if read_only {
                    sqlx::query("set default_transaction_read_only = on")
                        .execute(&mut *conn)
                        .await?;
                }
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(|error| error.to_string().replace(&password, "***"))
}

pub async fn cards(pool: &PgPool, schema: &str) -> Result<Vec<Card>, sqlx::Error> {
    let sql = format!(
        r#"select p.id, coalesce(p.blueprint->>'source_key', p.id::text) as key,
             coalesce(p.blueprint->>'source', '') as source, p.name,
             coalesce(p.expansion->>'name', '') as set_name, coalesce(p.expansion->>'code', '') as set_code,
             coalesce(p.blueprint->'fixed_properties'->>'collector_number', '') as collector,
             coalesce(p.blueprint->'fixed_properties'->>'cm_rarity', '') as rarity,
             coalesce(p.blueprint->'fixed_properties'->>'language', '') as language,
             coalesce((select array_agg(v::bigint) from jsonb_array_elements_text(
               case when jsonb_typeof(p.card_market_ids) = 'array' then p.card_market_ids else '[]'::jsonb end) v
               where v ~ '^[0-9]+$'), '{{}}') as cm,
             (select min(c.card_id) from public.marketplace_search_candidates c where c.ct_id = p.id) as card_id
           from "{schema}".cardmarket_products p order by p.id"#
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(Card {
            id: row.try_get("id")?,
            key: row.try_get("key")?,
            source: row.try_get("source")?,
            name: row.try_get("name")?,
            set_name: row.try_get("set_name")?,
            set_code: row.try_get("set_code")?,
            collector: row.try_get("collector")?,
            rarity: row.try_get("rarity")?,
            language: row.try_get("language")?,
            card_market_ids: row.try_get("cm")?,
            card_id: row.try_get("card_id")?,
        });
    }
    Ok(out)
}

/// The session a planning read runs under: Postgres refuses to write in it and
/// stops the statement after `statement_timeout_secs`. Both settings reach
/// `set_config` as binds rather than as SQL text, and the caller keeps the one
/// connection the guards were applied to, so a read cannot be handed to a
/// connection that is neither bounded nor read-only.
pub async fn read_session(
    conn: &mut PgConnection,
    statement_timeout_secs: u64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "select set_config('statement_timeout', $1, false),
                set_config('default_transaction_read_only', 'on', false)",
    )
    .bind(format!("{statement_timeout_secs}s"))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The timeout one `cm-daily` load runs under, as the first statement of its
/// own transaction. Transaction scope, not [`read_session`]'s session scope:
/// this runs on a pooled connection, and a 60-second timeout left on the
/// session would be handed to whatever borrows that connection next, including
/// a load this command did not aim at. `cm_daily::STATEMENT_TIMEOUT_SECS` is
/// the number; the value reaches Postgres as a bind.
pub const DAILY_TIMEOUT_SQL: &str = "select set_config('statement_timeout', $1, true)";

pub async fn has_table(pool: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>("select to_regclass($1) is not null")
        .bind(name)
        .fetch_one(pool)
        .await
}

/// The distinct Cardmarket idProducts a game's catalog references
/// (`card_market_ids` of `catalog_table`, e.g. `"marketplace_magic".cardtrader_blueprints`).
pub async fn referenced_products(
    pool: &PgPool,
    catalog_table: &str,
) -> Result<HashSet<i64>, sqlx::Error> {
    let sql = format!(
        r#"select distinct v::bigint from {catalog_table} b
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(b.card_market_ids) = 'array' then b.card_market_ids else '[]'::jsonb end) v
           where v ~ '^[0-9]+$'"#
    );
    let ids: Vec<i64> = sqlx::query_scalar(&sql).fetch_all(pool).await?;
    Ok(ids.into_iter().collect())
}

/// One Cardmarket build of the price guide, keyed by idProduct and day.
pub async fn store_guide(
    pool: &PgPool,
    day: &str,
    rows: &[PriceGuide],
) -> Result<u64, sqlx::Error> {
    let mut written = 0;
    for chunk in rows.chunks(2000) {
        let col = |f: fn(&PriceGuide) -> Option<f64>| chunk.iter().map(f).collect::<Vec<_>>();
        let ids: Vec<i64> = chunk.iter().map(|r| r.id).collect();
        let cats: Vec<Option<i64>> = chunk.iter().map(|r| r.category).collect();
        let done = sqlx::query(
            "insert into public.cardmarket_price_guide_daily
               (id_product, day, id_category, avg, low, trend, avg1, avg7, avg30,
                avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil, loaded_at)
             select u.id_product, $1::date, u.id_category::int, u.avg, u.low, u.trend, u.avg1, u.avg7, u.avg30,
               u.avg_foil, u.low_foil, u.trend_foil, u.avg1_foil, u.avg7_foil, u.avg30_foil, now()
             from unnest($2::bigint[], $3::bigint[], $4::float8[], $5::float8[], $6::float8[],
               $7::float8[], $8::float8[], $9::float8[], $10::float8[], $11::float8[], $12::float8[],
               $13::float8[], $14::float8[], $15::float8[])
               as u(id_product, id_category, avg, low, trend, avg1, avg7, avg30,
                 avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil)
             on conflict (id_product, day) do update set id_category = excluded.id_category,
               avg = excluded.avg, low = excluded.low, trend = excluded.trend, avg1 = excluded.avg1,
               avg7 = excluded.avg7, avg30 = excluded.avg30, avg_foil = excluded.avg_foil,
               low_foil = excluded.low_foil, trend_foil = excluded.trend_foil, avg1_foil = excluded.avg1_foil,
               avg7_foil = excluded.avg7_foil, avg30_foil = excluded.avg30_foil, loaded_at = now()",
        )
        .bind(day)
        .bind(&ids)
        .bind(&cats)
        .bind(col(|r| r.avg))
        .bind(col(|r| r.low))
        .bind(col(|r| r.trend))
        .bind(col(|r| r.avg1))
        .bind(col(|r| r.avg7))
        .bind(col(|r| r.avg30))
        .bind(col(|r| r.avg_foil))
        .bind(col(|r| r.low_foil))
        .bind(col(|r| r.trend_foil))
        .bind(col(|r| r.avg1_foil))
        .bind(col(|r| r.avg7_foil))
        .bind(col(|r| r.avg30_foil))
        .execute(pool)
        .await?;
        written += done.rows_affected();
    }
    Ok(written)
}

/// One game's price guide as change-only history in
/// `public.cardmarket_price_guide` (migration 139): a row is written only
/// when the product's values differ from its newest stored row on or before
/// `day`, plus the `cardmarket_price_guide_runs` bookkeeping row. All in one
/// transaction, committed only when `apply` — a dry run still executes every
/// statement (so the counts are real) and then rolls back. Returns
/// (products in the guide, rows written).
pub async fn store_guide_changes(
    pool: &PgPool,
    game: &str,
    id_game: i64,
    day: &str,
    rows: &[PriceGuide],
    apply: bool,
) -> Result<(u64, u64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "create temp table incoming (
           id_product bigint primary key,
           id_category integer,
           avg numeric, low numeric, trend numeric, avg1 numeric, avg7 numeric, avg30 numeric,
           avg_foil numeric, low_foil numeric, trend_foil numeric,
           avg1_foil numeric, avg7_foil numeric, avg30_foil numeric
         ) on commit drop",
    )
    .execute(&mut *tx)
    .await?;
    for chunk in rows.chunks(5000) {
        let col = |f: fn(&PriceGuide) -> Option<f64>| chunk.iter().map(f).collect::<Vec<_>>();
        let ids: Vec<i64> = chunk.iter().map(|r| r.id).collect();
        let cats: Vec<Option<i64>> = chunk.iter().map(|r| r.category).collect();
        sqlx::query(
            "insert into incoming (id_product, id_category, avg, low, trend, avg1, avg7, avg30,
               avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil)
             select u.id_product, u.id_category::int, u.avg::numeric, u.low::numeric, u.trend::numeric,
               u.avg1::numeric, u.avg7::numeric, u.avg30::numeric, u.avg_foil::numeric, u.low_foil::numeric,
               u.trend_foil::numeric, u.avg1_foil::numeric, u.avg7_foil::numeric, u.avg30_foil::numeric
             from unnest($1::bigint[], $2::bigint[], $3::float8[], $4::float8[], $5::float8[],
               $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[], $11::float8[],
               $12::float8[], $13::float8[], $14::float8[])
               as u(id_product, id_category, avg, low, trend, avg1, avg7, avg30,
                 avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil)
             on conflict (id_product) do nothing",
        )
        .bind(&ids)
        .bind(&cats)
        .bind(col(|r| r.avg))
        .bind(col(|r| r.low))
        .bind(col(|r| r.trend))
        .bind(col(|r| r.avg1))
        .bind(col(|r| r.avg7))
        .bind(col(|r| r.avg30))
        .bind(col(|r| r.avg_foil))
        .bind(col(|r| r.low_foil))
        .bind(col(|r| r.trend_foil))
        .bind(col(|r| r.avg1_foil))
        .bind(col(|r| r.avg7_foil))
        .bind(col(|r| r.avg30_foil))
        .execute(&mut *tx)
        .await?;
    }
    let changed = sqlx::query(
        "insert into public.cardmarket_price_guide (game, id_product, day, id_category, avg, low, trend, avg1, avg7, avg30,
           avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil, loaded_at)
         select $1, i.id_product, $2::date, i.id_category, i.avg, i.low, i.trend, i.avg1, i.avg7, i.avg30,
           i.avg_foil, i.low_foil, i.trend_foil, i.avg1_foil, i.avg7_foil, i.avg30_foil, now()
         from incoming i
         left join lateral (
           select * from public.cardmarket_price_guide g
           where g.game = $1 and g.id_product = i.id_product and g.day <= $2::date
           order by g.day desc limit 1) l on true
         where l.id_product is null
            or (l.id_category, l.avg, l.low, l.trend, l.avg1, l.avg7, l.avg30, l.avg_foil, l.low_foil, l.trend_foil, l.avg1_foil, l.avg7_foil, l.avg30_foil)
               is distinct from
               (i.id_category, i.avg, i.low, i.trend, i.avg1, i.avg7, i.avg30, i.avg_foil, i.low_foil, i.trend_foil, i.avg1_foil, i.avg7_foil, i.avg30_foil)
         on conflict (game, id_product, day) do update set id_category = excluded.id_category, avg = excluded.avg, low = excluded.low,
           trend = excluded.trend, avg1 = excluded.avg1, avg7 = excluded.avg7, avg30 = excluded.avg30, avg_foil = excluded.avg_foil,
           low_foil = excluded.low_foil, trend_foil = excluded.trend_foil, avg1_foil = excluded.avg1_foil, avg7_foil = excluded.avg7_foil,
           avg30_foil = excluded.avg30_foil, loaded_at = now()",
    )
    .bind(game)
    .bind(day)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let products: i64 = sqlx::query_scalar("select count(*) from incoming")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(
        "insert into public.cardmarket_price_guide_runs (game, day, id_game, products, changed, loaded_at)
         values ($1, $2::date, $3, $4, $5, now())
         on conflict (game, day) do update set id_game = excluded.id_game, products = excluded.products,
           changed = excluded.changed, loaded_at = now()",
    )
    .bind(game)
    .bind(day)
    .bind(id_game as i32)
    .bind(products as i32)
    .bind(changed as i32)
    .execute(&mut *tx)
    .await?;
    if apply {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok((products as u64, changed))
}

/// Change-only history of TCGNotify's cheapest ask, one game and day at a
/// time (migration 140). Same shape as `store_guide_changes`: a row is written
/// only when the ask differs from the product's newest stored row, and the run
/// is recorded either way. Without `apply` the transaction rolls back.
pub async fn store_asks(
    pool: &PgPool,
    game: &str,
    day: &str,
    rows: &[Ask],
    apply: bool,
) -> Result<(u64, u64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "create temp table incoming_asks (
           id_product bigint primary key,
           min_price numeric
         ) on commit drop",
    )
    .execute(&mut *tx)
    .await?;
    for chunk in rows.chunks(5000) {
        let ids: Vec<i64> = chunk.iter().map(|r| r.id_product).collect();
        let prices: Vec<Option<f64>> = chunk.iter().map(|r| r.min_price).collect();
        sqlx::query(
            "insert into incoming_asks (id_product, min_price)
             select u.id_product, u.min_price::numeric
             from unnest($1::bigint[], $2::float8[]) as u(id_product, min_price)
             on conflict (id_product) do nothing",
        )
        .bind(&ids)
        .bind(&prices)
        .execute(&mut *tx)
        .await?;
    }
    let changed = sqlx::query(
        "insert into public.tcgnotify_price_guide (game, id_product, day, min_price, loaded_at)
         select $1, i.id_product, $2::date, i.min_price, now()
         from incoming_asks i
         left join lateral (
           select * from public.tcgnotify_price_guide g
           where g.game = $1 and g.id_product = i.id_product and g.day <= $2::date
           order by g.day desc limit 1) l on true
         where l.id_product is null or l.min_price is distinct from i.min_price
         on conflict (game, id_product, day) do update set min_price = excluded.min_price,
           loaded_at = now()",
    )
    .bind(game)
    .bind(day)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let products: i64 = sqlx::query_scalar("select count(*) from incoming_asks")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(
        "insert into public.tcgnotify_price_guide_runs (game, day, products, changed, loaded_at)
         values ($1, $2::date, $3, $4, now())
         on conflict (game, day) do update set products = excluded.products,
           changed = excluded.changed, loaded_at = now()",
    )
    .bind(game)
    .bind(day)
    .bind(products as i32)
    .bind(changed as i32)
    .execute(&mut *tx)
    .await?;
    if apply {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok((products as u64, changed))
}

/// The newest Cardmarket offer minimum of every facet the harvest settled
/// (migration 141), one row per facet. A re-harvest replaces its answer only
/// when the observation is newer, so replaying an old file cannot roll the
/// pricer back to a stale ask. Returns the facets offered and the rows that
/// changed. Without `apply` the transaction rolls back.
pub async fn store_offer_minimums(
    pool: &PgPool,
    rows: &[Minimum],
    apply: bool,
) -> Result<(u64, u64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "create temp table incoming_minimums (
           cm_product_id bigint,
           language text,
           condition text,
           finish text,
           first_edition text,
           seller_type text,
           min_cents integer,
           offers integer,
           counts_complete boolean,
           observed_at timestamptz,
           primary key (cm_product_id, language, condition, finish, first_edition, seller_type)
         ) on commit drop",
    )
    .execute(&mut *tx)
    .await?;
    for chunk in rows.chunks(5000) {
        let ids: Vec<i64> = chunk.iter().map(|r| r.id_product).collect();
        let languages: Vec<String> = chunk.iter().map(|r| r.language.clone()).collect();
        let conditions: Vec<String> = chunk.iter().map(|r| r.condition.clone()).collect();
        let finishes: Vec<String> = chunk.iter().map(|r| r.finish.clone()).collect();
        let editions: Vec<String> = chunk.iter().map(|r| r.first_edition.clone()).collect();
        let sellers: Vec<String> = chunk.iter().map(|r| r.seller_type.clone()).collect();
        let cents: Vec<i64> = chunk.iter().map(|r| r.min_cents).collect();
        let offers: Vec<Option<i32>> = chunk.iter().map(|r| r.offers.map(|n| n as i32)).collect();
        let complete: Vec<Option<bool>> = chunk.iter().map(|r| r.counts_complete).collect();
        let observed: Vec<String> = chunk.iter().map(|r| r.observed_at.clone()).collect();
        sqlx::query(
            "insert into incoming_minimums (cm_product_id, language, condition, finish,
               first_edition, seller_type, min_cents, offers, counts_complete, observed_at)
             select u.cm_product_id, u.language, u.condition, u.finish, u.first_edition,
               u.seller_type, u.min_cents::integer, u.offers, u.counts_complete,
               u.observed_at::timestamptz
             from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[],
               $6::text[], $7::bigint[], $8::integer[], $9::boolean[], $10::text[])
               as u(cm_product_id, language, condition, finish, first_edition, seller_type,
                    min_cents, offers, counts_complete, observed_at)",
        )
        .bind(&ids)
        .bind(&languages)
        .bind(&conditions)
        .bind(&finishes)
        .bind(&editions)
        .bind(&sellers)
        .bind(&cents)
        .bind(&offers)
        .bind(&complete)
        .bind(&observed)
        .execute(&mut *tx)
        .await?;
    }
    let changed = sqlx::query(
        "insert into public.cardmarket_offer_minimums as minimum (cm_product_id, language,
           condition, finish, first_edition, seller_type, min_cents, offers, counts_complete,
           observed_at, loaded_at)
         select i.cm_product_id, i.language, i.condition, i.finish, i.first_edition,
           i.seller_type, i.min_cents, i.offers, i.counts_complete, i.observed_at, now()
         from incoming_minimums i
         on conflict (cm_product_id, language, condition, finish, first_edition, seller_type)
         do update set min_cents = excluded.min_cents, offers = excluded.offers,
           counts_complete = excluded.counts_complete, observed_at = excluded.observed_at,
           loaded_at = now()
         where excluded.observed_at > minimum.observed_at",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let facets: i64 = sqlx::query_scalar("select count(*) from incoming_minimums")
        .fetch_one(&mut *tx)
        .await?;
    if apply {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok((facets as u64, changed))
}

/// The staging table of one day's file: the facet is keyed exactly as the
/// permanent table is, so a file that names one facet twice cannot reach the
/// load twice (`cm_daily::parse` folds the duplicates first; this is the second
/// line of defence, and `on conflict do nothing` in the stage keeps it from
/// aborting the day).
pub const DAILY_STAGING_SQL: &str = r#"create temp table incoming_daily (
           cm_product_id bigint,
           day date,
           language text,
           condition text,
           seller_type text,
           finish text,
           first_edition text,
           min_cents integer,
           offer_count integer,
           counts_complete boolean,
           asked boolean,
           observed_at timestamptz,
           primary key (cm_product_id, day, language, condition, seller_type, finish, first_edition)
         ) on commit drop"#;

/// One chunk of the day's file into the staging table, every value a bind: the
/// day and the observation time arrive as text and are cast in the select, so
/// no value is ever written into the statement's text.
pub const DAILY_STAGE_SQL: &str = r#"insert into incoming_daily (cm_product_id, day, language,
           condition, seller_type, finish, first_edition, min_cents, offer_count,
           counts_complete, asked, observed_at)
         select u.cm_product_id, u.day::date, u.language, u.condition, u.seller_type,
           u.finish, u.first_edition, u.min_cents::integer, u.offer_count,
           u.counts_complete, u.asked, u.observed_at::timestamptz
         from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[],
           $6::text[], $7::text[], $8::bigint[], $9::integer[], $10::boolean[],
           $11::boolean[], $12::text[])
           as u(cm_product_id, day, language, condition, seller_type, finish,
                first_edition, min_cents, offer_count, counts_complete, asked, observed_at)
         on conflict (cm_product_id, day, language, condition, seller_type, finish, first_edition)
           do nothing"#;

/// The binds [`DAILY_STAGE_SQL`] takes; the stage builder binds exactly this
/// many, and the unit test says so.
pub const DAILY_PARAM_COUNT: usize = 12;

/// The day's file into `cardmarket_offer_daily` (migration 145): one row per
/// facet per day. A facet already stored for that day is replaced only by a
/// newer observation, so replaying a rewritten file — the collector writes it
/// whole and atomically — cannot roll a day back to an older answer, and
/// `asked` is true for the day once any line said the walk aimed at the facet:
/// a price that only rode along on a wider page later must not erase the fact
/// that the facet was asked for. `loaded_at` says when this row arrived, which
/// is what a freshness check reads; the observation time stays separate.
pub const DAILY_LOAD_SQL: &str = r#"insert into public.cardmarket_offer_daily as daily
         (cm_product_id, day, language, condition, seller_type, finish, first_edition,
          min_cents, offer_count, counts_complete, asked, observed_at, loaded_at)
         select i.cm_product_id, i.day, i.language, i.condition, i.seller_type,
           i.finish, i.first_edition, i.min_cents, i.offer_count, i.counts_complete,
           i.asked, i.observed_at, now()
         from incoming_daily i
         on conflict (cm_product_id, day, language, condition, seller_type, finish, first_edition)
         do update set min_cents = excluded.min_cents, offer_count = excluded.offer_count,
           counts_complete = excluded.counts_complete,
           asked = excluded.asked or daily.asked,
           observed_at = excluded.observed_at, loaded_at = now()
         where excluded.observed_at > daily.observed_at"#;

/// Load one day's file into `public.cardmarket_offer_daily` (migration 145) in
/// one transaction: the timeout, then stage every row, then one upsert. Returns
/// (rows staged, rows that changed), so replaying the same file answers
/// `changed = 0` and a run whose table is missing answers an error, not a
/// silent zero. Nothing is committed here that a row of the file did not say.
pub async fn store_daily_offers(
    pool: &PgPool,
    rows: &[DailyOffer],
) -> Result<(u64, u64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(DAILY_TIMEOUT_SQL)
        .bind(format!("{}s", cm_daily::STATEMENT_TIMEOUT_SECS))
        .execute(&mut *tx)
        .await?;
    sqlx::query(DAILY_STAGING_SQL).execute(&mut *tx).await?;
    for chunk in rows.chunks(5000) {
        let col = |get: fn(&DailyOffer) -> String| chunk.iter().map(get).collect::<Vec<_>>();
        let ids: Vec<i64> = chunk.iter().map(|row| row.id_product).collect();
        let cents: Vec<i64> = chunk.iter().map(|row| row.min_cents).collect();
        let counts: Vec<Option<i32>> = chunk
            .iter()
            .map(|row| row.offer_count.map(|count| count as i32))
            .collect();
        let complete: Vec<Option<bool>> = chunk.iter().map(|row| row.counts_complete).collect();
        let asked: Vec<bool> = chunk.iter().map(|row| row.asked).collect();
        sqlx::query(DAILY_STAGE_SQL)
            .bind(&ids)
            .bind(col(|row| row.day.clone()))
            .bind(col(|row| row.language.clone()))
            .bind(col(|row| row.condition.clone()))
            .bind(col(|row| row.seller_type.clone()))
            .bind(col(|row| row.finish.clone()))
            .bind(col(|row| row.first_edition.clone()))
            .bind(&cents)
            .bind(&counts)
            .bind(&complete)
            .bind(&asked)
            .bind(col(|row| row.observed_at.clone()))
            .execute(&mut *tx)
            .await?;
    }
    let changed = sqlx::query(DAILY_LOAD_SQL)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let staged: i64 = sqlx::query_scalar("select count(*) from incoming_daily")
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((staged as u64, changed))
}

/// Upsert the display price per public card id; drop rows of cards that no
/// longer have a Cardmarket price (Cardmarket-only games have no other source).
pub async fn store_medians(
    pool: &PgPool,
    day: &str,
    rows: &[(i64, f64)],
) -> Result<(u64, u64), sqlx::Error> {
    let ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let pkns: Vec<f64> = rows.iter().map(|r| r.1).collect();
    let mut tx = pool.begin().await?;
    let upserted = sqlx::query(
        "insert into public.marketplace_card_daily_median (card_id, last_median_pkn, last_day, refreshed_at)
         select id, pkn, $3::date, now() from unnest($1::bigint[], $2::float8[]) as t(id, pkn)
         on conflict (card_id) do update set last_median_pkn = excluded.last_median_pkn,
           last_day = excluded.last_day, refreshed_at = now()",
    )
    .bind(&ids)
    .bind(&pkns)
    .bind(day)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // An empty load (a broken match file) never wipes the table.
    let removed = if ids.is_empty() {
        0
    } else {
        sqlx::query(
            "delete from public.marketplace_card_daily_median where card_id <> all($1::bigint[])",
        )
        .bind(&ids)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    tx.commit().await?;
    Ok((upserted, removed))
}

/// One printing → Cardmarket product page, for
/// `public.marketplace_cm_verified_links` (read by `/api/cardmarket-redirect`).
pub struct LinkRow<'a> {
    pub blueprint_id: i64,
    pub url: &'a str,
    pub product_slug: &'a str,
    pub name: &'a str,
    pub set_name: &'a str,
    pub collector: &'a str,
    pub notes: String,
}

/// Upsert links of one `source`. Hand-entered (`manual`) rows and URLs another
/// printing already holds are left alone; returns (written, skipped).
pub async fn store_links(
    pool: &PgPool,
    source: &str,
    rows: &[LinkRow<'_>],
) -> Result<(u64, u64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let (mut written, mut skipped) = (0, 0);
    for row in rows {
        let done = sqlx::query(
            "insert into public.marketplace_cm_verified_links (
               blueprint_id, cardmarket_locale, cardmarket_url, cardmarket_product_slug, card_name,
               expansion_name, collector_number, source, confidence, notes, verified_at, updated_at)
             select $1, 'en', $2, $3, $4, $5, $6, $7, 'verified', $8, now(), now()
             where not exists (select 1 from public.marketplace_cm_verified_links o
                               where o.cardmarket_url = $2 and o.blueprint_id <> $1)
             on conflict (blueprint_id, cardmarket_locale) do update set
               cardmarket_url = excluded.cardmarket_url,
               cardmarket_product_slug = excluded.cardmarket_product_slug,
               card_name = excluded.card_name, expansion_name = excluded.expansion_name,
               collector_number = excluded.collector_number, source = excluded.source,
               notes = excluded.notes, updated_at = now()
             where marketplace_cm_verified_links.confidence <> 'manual'",
        )
        .bind(row.blueprint_id)
        .bind(row.url)
        .bind(row.product_slug)
        .bind(row.name)
        .bind(row.set_name)
        .bind(row.collector)
        .bind(source)
        .bind(&row.notes)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if done == 0 {
            skipped += 1;
        }
        written += done;
    }
    tx.commit().await?;
    Ok((written, skipped))
}

/// A printing that shares another printing's Cardmarket page, for
/// `public.pokoin_printing_cm_links` (migration 130), keyed by public card id;
/// `/api/cardmarket-redirect` reads it before any other link.
pub struct PrintingLinkRow<'a> {
    pub public_id: i64,
    pub blueprint_id: i64,
    pub url: &'a str,
    pub product: i64,
    pub method: &'a str,
    pub series: &'a str,
}

/// Upsert the rows of one `source`; rows another source wrote are left alone.
/// Returns (written, skipped).
pub async fn store_printing_links(
    pool: &PgPool,
    source: &str,
    rows: &[PrintingLinkRow<'_>],
) -> Result<(u64, u64), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let (mut written, mut skipped) = (0, 0);
    for row in rows {
        let done = sqlx::query(
            "insert into public.pokoin_printing_cm_links
               (public_id, ct_id, cm_url, cm_product_id, n_candidates, method, all_urls, series, source, created_at)
             values ($1, $2, $3, $4, 1, $5, jsonb_build_array($3::text), $6, $7, now())
             on conflict (public_id) do update set ct_id = excluded.ct_id, cm_url = excluded.cm_url,
               cm_product_id = excluded.cm_product_id, method = excluded.method,
               all_urls = excluded.all_urls, series = excluded.series
             where pokoin_printing_cm_links.source = excluded.source",
        )
        .bind(row.public_id)
        .bind(row.blueprint_id)
        .bind(row.url)
        .bind(row.product)
        .bind(row.method)
        .bind(row.series)
        .bind(source)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if done == 0 {
            skipped += 1;
        }
        written += done;
    }
    tx.commit().await?;
    Ok((written, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One row of a real day: Dialga's IT NM private facet, with values chosen
    /// so that no one of them can be confused with a column or a keyword.
    fn offer() -> DailyOffer {
        DailyOffer {
            id_product: 279646,
            day: "2026-11-12".into(),
            language: "IT".into(),
            condition: "NM".into(),
            seller_type: "private".into(),
            finish: "Y".into(),
            first_edition: "N".into(),
            min_cents: 1955,
            offer_count: Some(4321),
            counts_complete: Some(true),
            asked: true,
            observed_at: "2026-11-12T13:09:30.235Z".into(),
        }
    }

    /// The statements that load a day carry no value in their text: what the
    /// file said reaches Postgres as a bind or a staged column, never as SQL.
    /// A price, a day or a product id found in the text would mean the loader
    /// writes SQL it built from the input.
    #[test]
    fn the_daily_statements_hold_no_value_from_the_file() {
        let row = offer();
        // The statements are all lower-case SQL with nothing but column names in
        // it, so a value that appears anywhere in one of them got there from the
        // file, not from the schema.
        let values: Vec<String> = [
            row.id_product.to_string(),
            row.day.clone(),
            row.language.clone(),
            row.condition.clone(),
            row.seller_type.clone(),
            row.finish.clone(),
            row.first_edition.clone(),
            row.min_cents.to_string(),
            row.offer_count.map(|c| c.to_string()).unwrap_or_default(),
            row.observed_at.clone(),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect();
        for sql in [
            DAILY_STAGING_SQL,
            DAILY_STAGE_SQL,
            DAILY_LOAD_SQL,
            DAILY_TIMEOUT_SQL,
        ] {
            for value in &values {
                assert!(!sql.contains(value.as_str()), "{sql} interpolates {value}");
            }
            // A surviving `format!` brace is the other half of the same story.
            assert!(!sql.contains(['{', '}']), "{sql} was formatted");
            // Nor a comment that carried a value into the statement.
            assert!(!sql.contains("--"), "{sql} carries a comment");
        }
    }

    /// The stage takes exactly the columns the file has, in the order the loader
    /// binds them: a new field is a new bind, and `DAILY_PARAM_COUNT` is what
    /// says it was added on both sides.
    #[test]
    fn the_daily_stage_binds_one_parameter_per_column() {
        for number in 1..=DAILY_PARAM_COUNT {
            let placeholder = format!("${number}::");
            assert!(
                DAILY_STAGE_SQL.contains(&placeholder),
                "bind {number} is missing from {DAILY_STAGE_SQL}"
            );
        }
        assert!(
            !DAILY_STAGE_SQL.contains(&format!("${}", DAILY_PARAM_COUNT + 1)),
            "a bind past the {DAILY_PARAM_COUNT} columns"
        );
        // The timeout is a bind too, not the number written into the statement.
        assert!(DAILY_TIMEOUT_SQL.contains("$1"));
        assert!(!DAILY_TIMEOUT_SQL.contains(&format!("{}", cm_daily::STATEMENT_TIMEOUT_SECS)));
    }

    /// The facet key the file is unique on, the staging table's key and the
    /// upsert's conflict target must be the same seven columns in the same
    /// order, or a replayed file writes a facet twice.
    #[test]
    fn the_daily_key_is_the_same_seven_columns_everywhere() {
        let key = "cm_product_id, day, language, condition, seller_type, finish, first_edition";
        assert!(DAILY_STAGING_SQL.contains(&format!("primary key ({key})")));
        assert!(DAILY_STAGE_SQL.contains(&format!("on conflict ({key})")));
        assert!(DAILY_LOAD_SQL.contains(&format!("on conflict ({key})")));
        // Newest observation wins, and `asked` is sticky once the walk aimed at
        // the facet: both rules live in the SQL the loader actually sends.
        assert!(DAILY_LOAD_SQL.contains("where excluded.observed_at > daily.observed_at"));
        assert!(DAILY_LOAD_SQL.contains("asked = excluded.asked or daily.asked"));
        assert!(DAILY_LOAD_SQL.contains("loaded_at = now()"));
    }
}
