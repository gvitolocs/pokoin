//! Writer access (nezopt `pokoin-marketplace-postgres-15t`, published on
//! 127.0.0.1:25433). Tables: the game's raw `cardmarket_products`, the search
//! candidates, migration 112 (`marketplace_card_daily_median`) and 126
//! (`cardmarket_price_guide_daily`). No DDL here.

use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{PgPool, Row};

use crate::sources::PriceGuide;

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

pub async fn has_table(pool: &PgPool, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>("select to_regclass($1) is not null")
        .bind(name)
        .fetch_one(pool)
        .await
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
