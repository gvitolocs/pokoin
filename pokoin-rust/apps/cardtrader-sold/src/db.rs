//! Game database reads and the `cardtrader_sold_daily` write. The table is the
//! Pokémon one (migration `scripts/sql/131_cardtrader_sold_daily_all_games.sql`);
//! the job creates it when a game database does not have it yet, as the price
//! cache does for its tables.

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{PgPool, Row};

use crate::nights::date_of;
use crate::sold::SoldRow;

pub const BATCH: usize = 5_000;

pub const CREATE_TABLE: &str = "
create table if not exists public.cardtrader_sold_daily (
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
  primary key (blueprint_id, observed_day, condition, language, reverse, first_edition, graded)
)";

pub const CREATE_INDEX: &str = "
create index if not exists cardtrader_sold_daily_blueprint_day_idx
  on public.cardtrader_sold_daily (blueprint_id, observed_day)";

pub async fn connect(
    database: &str,
    user: &str,
    password: &str,
    port: u16,
    read_only: bool,
) -> Result<PgPool, String> {
    let options = PgConnectOptions::new()
        .host("127.0.0.1")
        .port(port)
        .username(user)
        .password(password)
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
        .map_err(|error| redact(&error.to_string(), password))
}

pub fn redact(text: &str, password: &str) -> String {
    if password.is_empty() {
        text.to_string()
    } else {
        text.replace(password, "***")
    }
}

/// Pokémon expansion nationality by blueprint (`cardtrader_listing_language_for_blueprint`).
pub async fn pokemon_nationality(pool: &PgPool) -> Result<HashMap<i64, String>, sqlx::Error> {
    let rows = sqlx::query(
        "select b.id, coalesce(e.nationality, '') as nationality
         from public.pokoin_pokemon_blueprints b
         join public.pokoin_pokemon_expansions e on e.expansion_id = b.expansion_id",
    )
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        map.insert(row.try_get::<i64, _>(0)?, row.try_get::<String, _>(1)?);
    }
    Ok(map)
}

fn row_json(row: &SoldRow) -> Value {
    let round = |value: f64| (value * 1e6).round() / 1e6;
    json!({
        "blueprint_id": row.key.blueprint,
        "observed_day": date_of(row.key.day).to_string(),
        "condition": row.key.condition,
        "language": row.key.language,
        "reverse": row.key.reverse,
        "first_edition": row.key.first_edition,
        "graded": row.key.graded,
        "median_pkn": round(row.median_pkn),
        "min_pkn": round(row.min_pkn),
        "max_pkn": round(row.max_pkn),
        "sold_qty": row.sold_qty.min(i64::from(i32::MAX)),
        "listings": row.listings.min(i64::from(i32::MAX)),
        "sample_count": row.sample_count.min(i64::from(i32::MAX)),
        "graded_comments": row.graded_comments,
    })
}

/// Replaces the rows of removed days `[from, to]` in one transaction.
pub async fn write_rows(
    pool: &PgPool,
    from: i32,
    to: i32,
    rows: &[SoldRow],
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("set local statement_timeout = 0")
        .execute(&mut *tx)
        .await?;
    // Only when missing: pokoin_jobs has no DDL rights (migration 124), and
    // `create ... if not exists` still needs them.
    let exists: bool =
        sqlx::query_scalar("select to_regclass('public.cardtrader_sold_daily') is not null")
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        sqlx::query(CREATE_TABLE).execute(&mut *tx).await?;
        sqlx::query(CREATE_INDEX).execute(&mut *tx).await?;
    }
    sqlx::query(
        "delete from public.cardtrader_sold_daily where observed_day between $1::date and $2::date",
    )
    .bind(date_of(from).to_string())
    .bind(date_of(to).to_string())
    .execute(&mut *tx)
    .await?;
    let mut written = 0;
    for chunk in rows.chunks(BATCH) {
        let body = Value::Array(chunk.iter().map(row_json).collect());
        let result = sqlx::query(
            "insert into public.cardtrader_sold_daily
               (blueprint_id, observed_day, condition, language, reverse, first_edition, graded,
                median_pkn, min_pkn, max_pkn, sold_qty, listings, sample_count, graded_comments, refreshed_at)
             select blueprint_id, observed_day, condition, language, reverse, first_edition, graded,
                    median_pkn, min_pkn, max_pkn, sold_qty, listings, sample_count,
                    coalesce(graded_comments, '{}'::text[]), now()
             from jsonb_to_recordset($1::jsonb) as t(
               blueprint_id bigint, observed_day date, condition text, language text, reverse boolean,
               first_edition boolean, graded boolean, median_pkn numeric, min_pkn numeric, max_pkn numeric,
               sold_qty integer, listings integer, sample_count integer, graded_comments text[])",
        )
        .bind(body)
        .execute(&mut *tx)
        .await?;
        written += result.rows_affected();
    }
    tx.commit().await?;
    Ok(written)
}

/// Stored rows of `[from, to]`, keyed like [`crate::sold::SoldKey`] (compare mode).
pub async fn read_rows(pool: &PgPool, from: i32, to: i32) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "select blueprint_id, observed_day::text as day, condition, language, reverse, first_edition, graded,
                median_pkn::float8 as median, sold_qty::int8 as qty, listings::int8 as listings
         from public.cardtrader_sold_daily
         where observed_day between $1::date and $2::date",
    )
    .bind(date_of(from).to_string())
    .bind(date_of(to).to_string())
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(json!({
            "blueprint": row.try_get::<i64, _>("blueprint_id")?,
            "day": row.try_get::<String, _>("day")?,
            "condition": row.try_get::<String, _>("condition")?,
            "language": row.try_get::<String, _>("language")?,
            "reverse": row.try_get::<bool, _>("reverse")?,
            "firstEdition": row.try_get::<bool, _>("first_edition")?,
            "graded": row.try_get::<bool, _>("graded")?,
            "median": row.try_get::<f64, _>("median")?,
            "qty": row.try_get::<i64, _>("qty")?,
            "listings": row.try_get::<i64, _>("listings")?,
        }));
    }
    Ok(out)
}
