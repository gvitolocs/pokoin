use serde_json::Value;
use sqlx::Row;
use sqlx::PgPool;

use crate::sales_shape::*;
use crate::sales_slice::SoldSlice;
use crate::sales_sql::*;
use crate::util::*;

pub struct QueryOutcome {
    pub rows: Vec<Value>,
    pub missing: bool,
}

/// Row -> JSON object with the same column names the Node reference reads.
fn row_to_json(row: &Row) -> Value {
    let mut map = serde_json::Map::new();
    for column in row.columns() {
        let value: Value = row
            .try_get::<Value, _>(column.name())
            .unwrap_or(Value::Null);
        map.insert(column.name().to_string(), value);
    }
    Value::Object(map)
}

async fn run(pool: &PgPool, sql: &str, binds: &[Value]) -> QueryOutcome {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(bind);
    }
    match query.fetch_all(pool).await {
        Ok(rows) => QueryOutcome {
            rows: rows.iter().map(row_to_json).collect(),
            missing: false,
        },
        Err(error) if is_missing_relation(&error) => QueryOutcome {
            rows: Vec::new(),
            missing: true,
        },
        Err(error) => Err(error.into()),
    }
}

/// `soldSliceSql(startIndex)` — normalized condition/language/flag predicates.
/// The reference builds `$N` placeholders; here the slice binds are always the
/// second..sixth parameters, so the placeholders are literal `$1..$5`.
pub fn sold_slice_sql() -> String {
    "
    and ($1::text = '' or ({SOLD_CONDITION_SQL}) = $1)
    and ($2::text = '' or ({SOLD_LANGUAGE_SQL}) = $2)
    and ($3::boolean is null or reverse = $3)
    and ($4::boolean is null or first_edition = $4)
    and ($5::boolean is null or graded = $5)
  "
    .to_string()
    .replace("{SOLD_CONDITION_SQL}", SOLD_CONDITION_SQL)
    .replace("{SOLD_LANGUAGE_SQL}", SOLD_LANGUAGE_SQL)
}

/// `soldDailySliceSql(startIndex)` — cardtrader_sold_daily stores normalized keys.
pub fn sold_daily_slice_sql() -> String {
    "
    and ($1::text = '' or condition = $1)
    and ($2::text = '' or language = $2)
    and ($3::boolean is null or reverse = $3)
    and ($4::boolean is null or first_edition = $4)
    and ($5::boolean is null or graded = $5)
  "
    .to_string()
}

pub async fn read_oracle_card_sales(
    pool: &PgPool,
    card_id: i64,
    limit: i64,
    slice: &SoldSlice,
) -> Result<Vec<Value>, RouteError> {
    let values = sold_slice_values(slice);
    let slice_sql = sold_slice_sql();
    let sql = format!(
        "
      select
        id,
        blueprint_id,
        source,
        source_item_id,
        observed_at,
        price_pkn,
        quantity,
        condition,
        language,
        graded,
        grading_company,
        grade,
        created_at
      from public.marketplace_price_observations
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        and price_pkn > 0
        and source = 'cardtrader_removed_sale'
        and {SOLD_ONCE_LISTING_SQL}
        {slice_sql}
      order by observed_at desc, created_at desc
      limit $6
    "
    );
    let mut binds = vec![Value::from(card_id)];
    binds.extend(values);
    binds.push(Value::from(limit));
    let outcome = run(pool, &sql, &binds).await?;
    let mut rows: Vec<Value> = outcome
        .rows
        .iter()
        .map(|row| normalize_oracle_sale(row, &card_id.to_string()))
        .filter(|sale| {
            sale.get("cardId").and_then(|v| v.as_str()) == Some(&card_id.to_string())
                && sale.get("pricePkn").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0
                && !sale
                    .get("soldAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .is_empty()
        })
        .collect();
    rows.sort_by(|a, b| iso_str(a, "soldAt").cmp(&iso_str(b, "soldAt")));
    if rows.len() > limit as usize {
        rows.truncate(limit as usize);
    }
    Ok(rows)
}

fn iso_str(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub async fn read_oracle_sold_daily_rows(
    pool: &PgPool,
    card_id: i64,
    slice: &SoldSlice,
) -> Result<QueryOutcome, RouteError> {
    let values = sold_slice_values(slice);
    let daily_slice_sql = sold_daily_slice_sql();
    let sql = format!(
        "
      select
        observed_day as day,
        condition,
        language,
        reverse,
        first_edition,
        graded,
        median_pkn,
        min_pkn,
        max_pkn,
        sold_qty,
        listings,
        sample_count,
        graded_comments
      from public.cardtrader_sold_daily
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        {daily_slice_sql}
      order by 1
    "
    );
    let mut binds = vec![Value::from(card_id)];
    binds.extend(values);
    run(pool, &sql, &binds).await
}

pub async fn read_oracle_card_sales_series(
    pool: &PgPool,
    card_id: i64,
    slice: &SoldSlice,
) -> Result<Value, RouteError> {
    let daily = read_oracle_sold_daily_rows(pool, card_id, slice).await?;
    if !daily.missing {
        return Ok(build_sales_series(&merge_sold_daily_rows(&daily.rows)));
    }
    let values = sold_slice_values(slice);
    let slice_sql = sold_slice_sql();
    let sql = format!(
        "
      select
        (observed_at at time zone 'utc')::date as day,
        percentile_cont(0.5) within group (order by price_pkn) as median_pkn,
        min(price_pkn) as min_pkn,
        max(price_pkn) as max_pkn,
        coalesce(sum(quantity), 0)::integer as sold_qty,
        count(*)::integer as listings,
        count(*)::integer as sample_count
      from public.marketplace_price_observations
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        and price_pkn > 0
        and source = 'cardtrader_removed_sale'
        and {SOLD_ONCE_LISTING_SQL}
        {slice_sql}
      group by 1
      order by 1
    "
    );
    let mut binds = vec![Value::from(card_id)];
    binds.extend(values);
    let outcome = run(pool, &sql, &binds).await?;
    Ok(build_sales_series(&outcome.rows))
}

pub async fn read_oracle_sales_filters(
    pool: &PgPool,
    card_id: i64,
    slice: &SoldSlice,
) -> Result<Value, RouteError> {
    let sql = format!(
        "
      select distinct
        condition,
        language,
        reverse,
        first_edition,
        graded
      from public.cardtrader_sold_daily
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
    "
    );
    let daily = run(pool, &sql, &[Value::from(card_id)]).await?;
    if !daily.missing {
        return Ok(build_sales_filters(&daily.rows, slice));
    }
    let sql = format!(
        "
      select distinct
        {SOLD_CONDITION_SQL} as condition,
        {SOLD_LANGUAGE_SQL} as language,
        reverse,
        first_edition,
        graded
      from public.marketplace_price_observations
      where blueprint_id in ({SALES_BLUEPRINT_SQL})
        and price_pkn > 0
        and source = 'cardtrader_removed_sale'
        and {SOLD_ONCE_LISTING_SQL}
    "
    );
    let outcome = run(pool, &sql, &[Value::from(card_id)]).await?;
    Ok(build_sales_filters(&outcome.rows, slice))
}

pub async fn read_oracle_last_median(
    pool: &PgPool,
    card_id: i64,
    slice: &SoldSlice,
) -> Result<Value, RouteError> {
    let series = read_oracle_card_sales_series(pool, card_id, slice).await?;
    let last_day = series.get("lastDay").cloned().unwrap_or(Value::Null);
    let last_median = series.get("lastMedianPkn").cloned().unwrap_or(Value::Null);
    let days = series.get("days").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let sample = days
        .last()
        .and_then(|d| d.get("sampleCount"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let row = serde_json::json!({
        "day": last_day,
        "median_pkn": last_median,
        "sample_count": sample,
    });
    Ok(last_median_payload(&card_id.to_string(), &row, slice))
}
