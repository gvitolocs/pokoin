//! Pricing groups in Postgres (scripts/sql/138_seller_pricing_groups.sql).
//! Every read and write goes to the writer, so a group just saved reads back.
//! The rules (names, strategies, the plan) are `crate::pricing`.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

const GROUPS_SQL: &str = "
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'strategyId', g.strategy_id, 'autoDaily', g.auto_daily,
    'createdAt', to_char(g.created_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
    'updatedAt', to_char(g.updated_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
    'lastAppliedAt', to_char(g.last_applied_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
    'lastApplied', g.last_applied,
    'listingCount', (select count(*) from public.seller_pricing_group_members m where m.group_id = g.id)
  )
  from public.seller_pricing_groups g
  where g.seller_uid = $1
  order by lower(g.name), g.id";

/// The seller's groups, by name, each with its listing count.
pub async fn list_groups(db: &PgPool, uid: &str) -> ApiResult<Vec<Value>> {
    Ok(sqlx::query_scalar::<_, Value>(GROUPS_SQL).bind(uid).fetch_all(db).await?)
}

/// One group of this seller.
pub async fn group(db: &PgPool, uid: &str, id: &str) -> ApiResult<Option<Value>> {
    Ok(list_groups(db, uid).await?.into_iter().find(|g| g["id"] == id))
}

const UPSERT_SQL: &str = "
  insert into public.seller_pricing_groups (id, seller_uid, name, strategy_id, auto_daily)
  values ($1, $2, $3, $4, $5)
  on conflict (id) do update
    set name = excluded.name, strategy_id = excluded.strategy_id, auto_daily = excluded.auto_daily, updated_at = now()
    where seller_pricing_groups.seller_uid = excluded.seller_uid
  returning id";

/// Create or edit a sanitized group (`pricing::sanitize_group`). Another
/// seller's id never changes hands: the update only matches its owner.
pub async fn upsert_group(db: &PgPool, uid: &str, group: &Value) -> ApiResult<()> {
    let text = |key: &str| group[key].as_str().unwrap_or("").to_string();
    let saved = sqlx::query_scalar::<_, String>(UPSERT_SQL)
        .bind(text("id"))
        .bind(uid)
        .bind(text("name"))
        .bind(text("strategyId"))
        .bind(group["autoDaily"] == true)
        .fetch_optional(db)
        .await
        .map_err(|error| match &error {
            sqlx::Error::Database(db_error) if db_error.code().as_deref() == Some("23505") => {
                ApiError::conflict("You already have a group with that name.").with_code("group_name_taken")
            }
            _ => ApiError::from(error),
        })?;
    if saved.is_none() {
        return Err(ApiError::not_found("Pricing group not found.").with_code("pricing_group_unknown"));
    }
    Ok(())
}

/// Delete a group; its listings leave it and keep their prices.
pub async fn delete_group(db: &PgPool, uid: &str, id: &str) -> ApiResult<bool> {
    let done = sqlx::query("delete from public.seller_pricing_groups where id = $1 and seller_uid = $2")
        .bind(id)
        .bind(uid)
        .execute(db)
        .await?;
    Ok(done.rows_affected() > 0)
}

/// `[listingId, groupId]` for every grouped listing of the seller.
pub async fn memberships(db: &PgPool, uid: &str) -> ApiResult<Vec<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "select listing_id::text, group_id from public.seller_pricing_group_members where seller_uid = $1",
    )
    .bind(uid)
    .fetch_all(db)
    .await?)
}

const ADD_SQL: &str = "
  insert into public.seller_pricing_group_members (listing_id, group_id, seller_uid)
  select l.id, g.id, $1
  from public.marketplace_user_listings l
  join public.seller_pricing_groups g on g.id = $2 and g.seller_uid = $1
  where l.id = any($3::uuid[]) and l.seller_uid = $1
  on conflict (listing_id) do update set group_id = excluded.group_id, added_at = now()
    where seller_pricing_group_members.seller_uid = excluded.seller_uid";

/// Put the seller's own listings in a group, moving them out of any other.
/// Ids that are not this seller's listings are ignored. Returns how many
/// listings are now in the group from this call.
pub async fn add_members(db: &PgPool, uid: &str, group_id: &str, ids: &[Uuid]) -> ApiResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let done = sqlx::query(ADD_SQL).bind(uid).bind(group_id).bind(ids).execute(db).await?;
    Ok(done.rows_affected())
}

/// Take listings out of whatever group they are in.
pub async fn remove_members(db: &PgPool, uid: &str, ids: &[Uuid]) -> ApiResult<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let done = sqlx::query("delete from public.seller_pricing_group_members where seller_uid = $1 and listing_id = any($2::uuid[])")
        .bind(uid)
        .bind(ids)
        .execute(db)
        .await?;
    Ok(done.rows_affected())
}

/// The listing columns the plan and the price check need.
const ROW_COLUMNS: &str = "l.id::text as id, l.card_id, l.card_name, l.set_name, l.collector_number,
  l.condition, l.language, l.foil_state, coalesce(l.reverse, false) as reverse,
  coalesce(l.first_edition, false) as first_edition, coalesce(l.graded, false) as graded,
  coalesce(l.signed, false) as signed, coalesce(l.altered, false) as altered,
  l.price_pkn::float8 as price_pkn, l.status, l.quantity_available,
  coalesce(nullif(l.marketplace_game, ''), 'pokemon') as marketplace_game";

/// The live or paused listings with stock in a group.
pub async fn group_rows(db: &PgPool, uid: &str, group_id: &str) -> ApiResult<Vec<Value>> {
    let sql = format!(
        "select to_jsonb(r) from (select {ROW_COLUMNS}
           from public.seller_pricing_group_members m
           join public.marketplace_user_listings l on l.id = m.listing_id
          where m.group_id = $1 and m.seller_uid = $2 and l.seller_uid = $2
            and l.status in ('active', 'paused') and l.quantity_available > 0
          order by l.card_name, l.id) r"
    );
    Ok(sqlx::query_scalar::<_, Value>(&sql).bind(group_id).bind(uid).fetch_all(db).await?)
}

/// The seller's live or paused listings with stock among `ids`.
pub async fn listing_rows(db: &PgPool, uid: &str, ids: &[Uuid]) -> ApiResult<Vec<Value>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "select to_jsonb(r) from (select {ROW_COLUMNS}
           from public.marketplace_user_listings l
          where l.id = any($1::uuid[]) and l.seller_uid = $2
            and l.status in ('active', 'paused') and l.quantity_available > 0
          order by l.card_name, l.id) r"
    );
    Ok(sqlx::query_scalar::<_, Value>(&sql).bind(ids).bind(uid).fetch_all(db).await?)
}

/// Every live or paused listing with stock of the seller (the one-time
/// migration of scoped strategies into groups).
pub async fn seller_rows(db: &PgPool, uid: &str) -> ApiResult<Vec<Value>> {
    let sql = format!(
        "select to_jsonb(r) from (select {ROW_COLUMNS}
           from public.marketplace_user_listings l
          where l.seller_uid = $1 and l.status in ('active', 'paused') and l.quantity_available > 0) r"
    );
    Ok(sqlx::query_scalar::<_, Value>(&sql).bind(uid).fetch_all(db).await?)
}

/// Names of the groups that use a strategy.
pub async fn groups_using_strategy(db: &PgPool, uid: &str, strategy_id: &str) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>(
        "select name from public.seller_pricing_groups where seller_uid = $1 and strategy_id = $2 order by lower(name)",
    )
    .bind(uid)
    .bind(strategy_id)
    .fetch_all(db)
    .await?)
}

/// Remember what the last apply of a group did.
pub async fn record_applied(db: &PgPool, uid: &str, group_id: &str, summary: &Value) -> ApiResult<()> {
    sqlx::query(
        "update public.seller_pricing_groups set last_applied_at = now(), last_applied = $3 where id = $1 and seller_uid = $2",
    )
    .bind(group_id)
    .bind(uid)
    .bind(summary)
    .execute(db)
    .await?;
    Ok(())
}

/// `(seller_uid, group_id)` of every group priced every day, oldest apply first.
pub async fn daily_groups(db: &PgPool) -> ApiResult<Vec<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "select seller_uid, id from public.seller_pricing_groups where auto_daily
          order by last_applied_at nulls first, id",
    )
    .fetch_all(db)
    .await?)
}

/// `"pg_…"` ids and listing uuids from a request body.
pub fn listing_ids(value: &Value) -> Vec<Uuid> {
    let mut ids: Vec<Uuid> = value
        .as_array()
        .map(|rows| rows.iter().filter_map(|id| Uuid::parse_str(id.as_str()?.trim()).ok()).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids.truncate(5_000);
    ids
}

/// The summary a group keeps of its last apply.
pub fn applied_summary(changed: usize, activated: usize, no_comp: usize, unchanged: usize, failed: usize, trigger: &str) -> Value {
    json!({ "changed": changed, "activated": activated, "noComp": no_comp, "unchanged": unchanged, "failed": failed, "trigger": trigger })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_writes_stay_inside_one_seller() {
        // A listing only joins a group of its own seller, and a move never
        // takes another seller's membership row.
        assert!(ADD_SQL.contains("l.seller_uid = $1") && ADD_SQL.contains("g.seller_uid = $1"));
        assert!(ADD_SQL.contains("where seller_pricing_group_members.seller_uid = excluded.seller_uid"));
        assert!(UPSERT_SQL.contains("where seller_pricing_groups.seller_uid = excluded.seller_uid"));
    }

    #[test]
    fn request_ids_are_uuids_deduped() {
        let a = "0b7f8f6e-3c55-4a8e-9d27-2c1f7c0d5e11";
        let ids = listing_ids(&json!([a, a, "nope", 7, " 0b7f8f6e-3c55-4a8e-9d27-2c1f7c0d5e12 "]));
        assert_eq!(ids.len(), 2);
        assert!(listing_ids(&json!("x")).is_empty());
    }
}
