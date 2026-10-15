//! Schema, scope, native listings, and the per-game cache write.

use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{PgPool, Row};

use crate::money::parse_rat;
use crate::rank::{Offer, Provider};

pub const BATCH: usize = 5_000;

const SCHEMA_SQL: &[&str] = &[
    "\
create table if not exists public.cardtrader_blueprint_listing_cache (
    provider text DEFAULT 'cardtrader'::text NOT NULL,
    blueprint_id bigint NOT NULL,
    pokoin_card_id text DEFAULT ''::text NOT NULL,
    cheapest_price_eur numeric,
    cheapest_price_pkn numeric,
    eligible_listing_count integer DEFAULT 0 NOT NULL,
    eligible_quantity integer DEFAULT 0 NOT NULL,
    sample_listing_id text DEFAULT ''::text NOT NULL,
    sample_product_id text DEFAULT ''::text NOT NULL,
    shipping_mode text DEFAULT ''::text NOT NULL,
    seller_country_code text DEFAULT ''::text NOT NULL,
    source_snapshot_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cardtrader_blueprint_listing_cache_pkey PRIMARY KEY (blueprint_id),
    CONSTRAINT cardtrader_blueprint_listing_cache_eligible_listing_count_check CHECK ((eligible_listing_count >= 0)),
    CONSTRAINT cardtrader_blueprint_listing_cache_eligible_quantity_check CHECK ((eligible_quantity >= 0))
)",
    "\
create index if not exists cardtrader_blueprint_listing_cache_available_idx \
ON public.cardtrader_blueprint_listing_cache USING btree (blueprint_id) \
WHERE ((eligible_listing_count > 0) AND (cheapest_price_pkn IS NOT NULL))",
    "\
create index if not exists cardtrader_blueprint_listing_cache_pokoin_available_idx \
ON public.cardtrader_blueprint_listing_cache USING btree (pokoin_card_id) \
WHERE ((provider = ANY (ARRAY['cardtrader'::text, 'pokoin_native'::text])) \
AND (pokoin_card_id <> ''::text) AND (eligible_listing_count > 0) AND (cheapest_price_pkn IS NOT NULL))",
    "\
create index if not exists cardtrader_blueprint_listing_cache_provider_updated_idx \
ON public.cardtrader_blueprint_listing_cache USING btree (provider, updated_at DESC)",
    "\
create or replace view public.cheapest_homepage_cache_blueprint AS
 SELECT provider, blueprint_id, pokoin_card_id, cheapest_price_eur, cheapest_price_pkn, eligible_listing_count,
    eligible_quantity, sample_listing_id, sample_product_id, shipping_mode, seller_country_code, source_snapshot_at, updated_at
   FROM public.cardtrader_blueprint_listing_cache",
];

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

pub async fn ensure_schema(pool: &PgPool) -> Result<(), sqlx::Error> {
    for statement in SCHEMA_SQL {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

pub async fn scope_ids(
    pool: &PgPool,
    schema: &str,
    table: &str,
    expansions: &[i64],
) -> Result<Vec<i64>, sqlx::Error> {
    if expansions.is_empty() {
        return Ok(Vec::new());
    }
    let sql =
        format!("select id from \"{schema}\".\"{table}\" where expansion_id = any($1::bigint[])");
    let rows = sqlx::query(&sql).bind(expansions).fetch_all(pool).await?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        ids.push(row.try_get::<i64, _>(0)?);
    }
    Ok(ids)
}

pub async fn card_ids(
    pool: &PgPool,
    blueprint_ids: &[i64],
) -> Result<std::collections::HashMap<i64, String>, sqlx::Error> {
    let mut out = std::collections::HashMap::new();
    for chunk in blueprint_ids.chunks(BATCH) {
        let rows = sqlx::query(
            "select distinct on (ct_id) ct_id, card_id::text as card_id \
             from public.marketplace_search_candidates \
             where ct_id = any($1::bigint[]) \
             order by ct_id, card_id",
        )
        .bind(chunk)
        .fetch_all(pool)
        .await?;
        for row in rows {
            out.insert(row.try_get("ct_id")?, row.try_get("card_id")?);
        }
    }
    Ok(out)
}

pub async fn native_offers(pool: &PgPool, slug: &str) -> Result<Vec<Offer>, sqlx::Error> {
    let rows = sqlx::query(
        "select id::text as listing_id, \
                left(coalesce(nullif(source_listing_id, ''), id::text), 160) as product_id, \
                card_id, \
                price_pkn::text as price_pkn, \
                quantity_available, \
                left(coalesce(seller_country, ''), 40) as seller_country, \
                updated_at::text as updated_at \
         from public.marketplace_user_listings \
         where coalesce(nullif(marketplace_game, ''), 'pokemon') = $1 \
           and card_id ~ '^[0-9]+$' \
           and status = 'active' \
           and coalesce(quantity_available, 0) > 0 \
           and price_pkn > 0 \
           and coalesce(shipping_available, true) = true \
           and not (nft_available = true and coalesce(shipping_available, false) = false)",
    )
    .bind(slug)
    .fetch_all(pool)
    .await?;
    let mut offers = Vec::with_capacity(rows.len());
    for row in rows {
        let card_id: String = row.try_get("card_id")?;
        let Some(blueprint_id) = native_blueprint_id(&card_id) else {
            continue;
        };
        let price_text: String = row.try_get("price_pkn")?;
        let Some(price_pkn) = parse_rat(&price_text).filter(|price| price.is_positive()) else {
            continue;
        };
        let listing_id: String = row.try_get("listing_id")?;
        let product_id: String = row.try_get("product_id")?;
        let quantity: i32 = row.try_get("quantity_available")?;
        let country: String = row.try_get("seller_country")?;
        let updated_at: String = row.try_get("updated_at")?;
        offers.push(Offer {
            blueprint_id,
            provider: Provider::Native,
            price_pkn,
            price_eur: None,
            listing_id,
            product_id,
            quantity: i64::from(quantity),
            country,
            shipping_mode: "pokoin_native",
            source_snapshot_at: Some(updated_at),
        });
    }
    Ok(offers)
}

#[derive(Clone, Debug)]
pub struct CacheRow {
    pub provider: &'static str,
    pub blueprint_id: i64,
    pub pokoin_card_id: String,
    pub price_eur: Option<String>,
    pub price_pkn: String,
    pub listing_count: i32,
    pub quantity: i32,
    pub listing_id: String,
    pub product_id: String,
    pub shipping_mode: String,
    pub country: String,
    pub source_snapshot_at: String,
}

pub struct WriteStats {
    pub upserted: i64,
    pub deleted: i64,
}

pub async fn write_cache(
    pool: &PgPool,
    scope: &[i64],
    rows: &[CacheRow],
    updated_at: &str,
) -> Result<WriteStats, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("drop table if exists pg_temp.price_cache_winners")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "create temp table price_cache_winners (
            provider text not null,
            blueprint_id bigint not null,
            pokoin_card_id text not null,
            cheapest_price_eur numeric,
            cheapest_price_pkn numeric,
            eligible_listing_count integer not null,
            eligible_quantity integer not null,
            sample_listing_id text not null,
            sample_product_id text not null,
            shipping_mode text not null,
            seller_country_code text not null,
            source_snapshot_at timestamptz
        ) on commit drop",
    )
    .execute(&mut *tx)
    .await?;
    for chunk in rows.chunks(BATCH) {
        insert_winners(&mut tx, chunk).await?;
    }
    let upserted = sqlx::query(
        "insert into public.cardtrader_blueprint_listing_cache (
            provider, blueprint_id, pokoin_card_id, cheapest_price_eur, cheapest_price_pkn,
            eligible_listing_count, eligible_quantity, sample_listing_id, sample_product_id,
            shipping_mode, seller_country_code, source_snapshot_at, updated_at
        )
        select provider, blueprint_id, pokoin_card_id, cheapest_price_eur, cheapest_price_pkn,
            eligible_listing_count, eligible_quantity, sample_listing_id, sample_product_id,
            shipping_mode, seller_country_code, source_snapshot_at, $1::timestamptz
        from price_cache_winners
        on conflict (blueprint_id) do update set
            provider = excluded.provider,
            pokoin_card_id = excluded.pokoin_card_id,
            cheapest_price_eur = excluded.cheapest_price_eur,
            cheapest_price_pkn = excluded.cheapest_price_pkn,
            eligible_listing_count = excluded.eligible_listing_count,
            eligible_quantity = excluded.eligible_quantity,
            sample_listing_id = excluded.sample_listing_id,
            sample_product_id = excluded.sample_product_id,
            shipping_mode = excluded.shipping_mode,
            seller_country_code = excluded.seller_country_code,
            source_snapshot_at = excluded.source_snapshot_at,
            updated_at = excluded.updated_at",
    )
    .bind(updated_at)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let mut deleted = 0i64;
    for chunk in scope.chunks(BATCH) {
        let removed = sqlx::query(
            "delete from public.cardtrader_blueprint_listing_cache
             where provider in ('cardtrader', 'pokoin_native')
               and blueprint_id = any($1::bigint[])
               and blueprint_id not in (select blueprint_id from price_cache_winners)",
        )
        .bind(chunk)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        deleted += i64::try_from(removed).unwrap_or(i64::MAX);
    }
    tx.commit().await?;
    Ok(WriteStats {
        upserted: i64::try_from(upserted).unwrap_or(i64::MAX),
        deleted,
    })
}

async fn insert_winners(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    rows: &[CacheRow],
) -> Result<(), sqlx::Error> {
    let mut provider = Vec::with_capacity(rows.len());
    let mut blueprint_id = Vec::with_capacity(rows.len());
    let mut pokoin_card_id = Vec::with_capacity(rows.len());
    let mut price_eur = Vec::with_capacity(rows.len());
    let mut price_pkn = Vec::with_capacity(rows.len());
    let mut listing_count = Vec::with_capacity(rows.len());
    let mut quantity = Vec::with_capacity(rows.len());
    let mut listing_id = Vec::with_capacity(rows.len());
    let mut product_id = Vec::with_capacity(rows.len());
    let mut shipping_mode = Vec::with_capacity(rows.len());
    let mut country = Vec::with_capacity(rows.len());
    let mut snapshot = Vec::with_capacity(rows.len());
    for row in rows {
        provider.push(row.provider);
        blueprint_id.push(row.blueprint_id);
        pokoin_card_id.push(row.pokoin_card_id.as_str());
        price_eur.push(row.price_eur.as_deref().unwrap_or(""));
        price_pkn.push(row.price_pkn.as_str());
        listing_count.push(row.listing_count);
        quantity.push(row.quantity);
        listing_id.push(row.listing_id.as_str());
        product_id.push(row.product_id.as_str());
        shipping_mode.push(row.shipping_mode.as_str());
        country.push(row.country.as_str());
        snapshot.push(row.source_snapshot_at.as_str());
    }
    sqlx::query(
        "insert into price_cache_winners (
            provider, blueprint_id, pokoin_card_id, cheapest_price_eur, cheapest_price_pkn,
            eligible_listing_count, eligible_quantity, sample_listing_id, sample_product_id,
            shipping_mode, seller_country_code, source_snapshot_at
        )
        select provider, blueprint_id, pokoin_card_id,
               nullif(price_eur, '')::numeric,
               price_pkn::numeric,
               listing_count, quantity,
               sample_listing_id, sample_product_id,
               shipping_mode, seller_country,
               nullif(snapshot, '')::timestamptz
        from unnest(
            $1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[],
            $6::int[], $7::int[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[]
        ) as t(
            provider, blueprint_id, pokoin_card_id, price_eur, price_pkn,
            listing_count, quantity, sample_listing_id, sample_product_id,
            shipping_mode, seller_country, snapshot
        )",
    )
    .bind(&provider)
    .bind(&blueprint_id)
    .bind(&pokoin_card_id)
    .bind(&price_eur)
    .bind(&price_pkn)
    .bind(&listing_count)
    .bind(&quantity)
    .bind(&listing_id)
    .bind(&product_id)
    .bind(&shipping_mode)
    .bind(&country)
    .bind(&snapshot)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Public `card_id` is blueprint × 2; only even positive ids map to a blueprint.
pub fn native_blueprint_id(card_id: &str) -> Option<i64> {
    let id = card_id.trim().parse::<i64>().ok()?;
    if id <= 0 || id % 2 != 0 {
        return None;
    }
    id.checked_div(2)
}

pub fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_string()
    } else {
        text.replace(secret, "***")
    }
}
