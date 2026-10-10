//! CardTrader seller inventory reconcile — native port of
//! `_cardtrader_inventory_sync.js`. COMPLETE exports only; the destructive
//! gate, vanished-product sale evidence, checkout holds, and the
//! one-day-ready asset mode are preserved exactly.

use std::collections::HashMap;

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::integration as ct_integration;
use crate::cardtrader::sync_core::*;
use crate::db::{bound_query, rows_to_json, DbPools};
use crate::error::{clean_text, clean_text_value, i64_field, ApiError, ApiResult, ValueExt};
use crate::firebase::FirestoreStore;

/// The columns the planner reads ([`ListingRow`]), nothing more: the reconcile
/// holds every listing of the seller for the whole run.
const LOAD_SELLER_LISTINGS_SQL: &str = r#"
      select id, card_id, quantity_available, status, source_listing_id, created_at
      from public.marketplace_user_listings
      where seller_uid = $1
        and status in ('active', 'paused', 'sold_out')
"#;

const LOAD_PRODUCT_LINKS_SQL: &str = r#"
        select ct_product_id, missing_from_ct
        from public.marketplace_cardtrader_product_links
        where seller_uid = $1
"#;

const UPSERT_PRODUCT_LINK_SQL: &str = r#"
        insert into public.marketplace_cardtrader_product_links (
          seller_uid, ct_product_id, listing_id, blueprint_id,
          last_ct_quantity, last_seen_at, origin, missing_from_ct, updated_at
        )
        values ($1, $2, $3::uuid, $4, $5, now(), $6, $7, now())
        on conflict (seller_uid, ct_product_id) do update set
          listing_id = excluded.listing_id,
          blueprint_id = excluded.blueprint_id,
          last_ct_quantity = excluded.last_ct_quantity,
          last_seen_at = case
            when excluded.missing_from_ct then marketplace_cardtrader_product_links.last_seen_at
            else now()
          end,
          origin = excluded.origin,
          missing_from_ct = excluded.missing_from_ct,
          updated_at = now()
"#;

const RECORD_SELLER_SYNC_SQL: &str = r#"
        insert into public.marketplace_cardtrader_seller_sync (
          seller_uid, last_sync_at, last_sync_ok, last_sync_incomplete,
          last_sync_error, last_sync_summary, last_complete_export_at,
          last_export_product_count, updated_at
        )
        values ($1, now(), $2, $3, $4, $5::jsonb,
                case when $6 then now() else null end, $7, now())
        on conflict (seller_uid) do update set
          last_sync_at = now(),
          last_sync_ok = excluded.last_sync_ok,
          last_sync_incomplete = excluded.last_sync_incomplete,
          last_sync_error = excluded.last_sync_error,
          last_sync_summary = excluded.last_sync_summary,
          last_complete_export_at = case
            when $6 then now()
            else marketplace_cardtrader_seller_sync.last_complete_export_at
          end,
          last_export_product_count = case
            when $6 then excluded.last_export_product_count
            else marketplace_cardtrader_seller_sync.last_export_product_count
          end,
          updated_at = now()
"#;

const READ_SELLER_SYNC_SQL: &str = r#"
        select last_sync_at, last_sync_ok, last_sync_incomplete, last_sync_error,
               last_sync_summary, last_complete_export_at, last_export_product_count
        from public.marketplace_cardtrader_seller_sync
        where seller_uid = $1
        limit 1
"#;

const CARD_METADATA_MANY_SQL: &str = r#"
          select
            card_id::text as card_id,
            coalesce(nullif(name, ''), '') as card_name,
            coalesce(nullif(set_name, ''), nullif(expansion_name, ''), $2) as set_name,
            coalesce(nullif(card_number, ''), '') as collector_number,
            coalesce(nullif(cdn_image_url, ''), nullif(preview_image_url, ''), nullif(image_url, ''), '') as card_image_url
          from public.marketplace_search_candidates
          where card_id::text = any($1::text[])
"#;

const APPLY_CT_QUANTITY_SQL: &str = r#"
      update public.marketplace_user_listings as listing
      set
        quantity_available = greatest(0, $2 - coalesce((
          select sum(hold.quantity)::int
          from public.marketplace_checkout_holds as hold
          where hold.listing_id = listing.id
        ), 0)),
        status = case
          when greatest(0, $2 - coalesce((
            select sum(hold.quantity)::int
            from public.marketplace_checkout_holds as hold
            where hold.listing_id = listing.id
          ), 0)) <= 0 then 'sold_out'
          when listing.status = 'sold_out' then 'active'
          else listing.status
        end,
        updated_at = now()
      where listing.id = $1::uuid
        and listing.source_listing_id like 'ct:%'
        and (
          $3::timestamptz is null
          or listing.updated_at <= $3::timestamptz
          or greatest(0, $2 - coalesce((
            select sum(hold.quantity)::int
            from public.marketplace_checkout_holds as hold
            where hold.listing_id = listing.id
          ), 0)) <= listing.quantity_available
        )
      returning listing.id, listing.quantity_available, listing.status, listing.card_id, listing.source_listing_id
"#;

const DELIST_CT_LISTING_SQL: &str = r#"
      update public.marketplace_user_listings
      set quantity_available = 0, status = 'inactive', updated_at = now()
      where id = $1::uuid
        and source_listing_id like 'ct:%'
        and status in ('active', 'paused', 'sold_out')
      returning id, quantity_available, status, card_id, source_listing_id
"#;

const LINK_EXISTING_LISTING_SQL: &str = r#"
      update public.marketplace_user_listings as listing
      set
        source_listing_id = $2,
        quantity_available = greatest(0, $3 - coalesce((
          select sum(hold.quantity)::int
          from public.marketplace_checkout_holds as hold
          where hold.listing_id = listing.id
        ), 0)),
        status = case
          when greatest(0, $3 - coalesce((
            select sum(hold.quantity)::int
            from public.marketplace_checkout_holds as hold
            where hold.listing_id = listing.id
          ), 0)) <= 0 then 'sold_out'
          else 'active'
        end,
        updated_at = now()
        {price_sql}
      where listing.id = $1::uuid
      returning listing.id, listing.source_listing_id, listing.quantity_available, listing.status, listing.card_id
"#;

const CREATE_IMPORTED_LISTING_SQL: &str = r#"
      insert into public.marketplace_user_listings (
        card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
        condition, language, price_pkn, quantity_available, signed, reverse,
        first_edition, foil_state, variant_state, sealed, graded,
        shipping_available, reserve_available, nft_available, seller_comment,
        source, source_listing_id, status, card_name, card_image_url,
        set_name, collector_number, altered, marketplace_game, location
      )
      values (
        $1,$2,$3,$4,'New',
        $5,$6,$7,$8,$9,$10,
        $11,$12,'',false,$13,
        true,false,false,$14,
        $15,$16,'active',$17,$18,
        $19,$20,$21,$22,$23
      )
      returning id, source_listing_id, quantity_available, status, card_id, marketplace_game, location
"#;

const REACTIVATE_HIDDEN_SQL: &str = r#"
        update public.marketplace_user_listings
        set status = 'active', quantity_available = $2, price_pkn = $3,
            location = case
              when $4 <> '' then $4
              else coalesce(location, '')
            end,
            updated_at = now()
        where id = $1::uuid
        returning id, source_listing_id, quantity_available, status, card_id, location
"#;

const PATCH_LOCATION_IF_EMPTY_SQL: &str = r#"
          update public.marketplace_user_listings
          set location = $2, updated_at = now()
          where id = $1::uuid
          returning id, source_listing_id, quantity_available, status, card_id, location
"#;

const FIND_EXISTING_BY_SOURCE_SQL: &str = r#"
      select id, source_listing_id, quantity_available, status, card_id, location
      from public.marketplace_user_listings
      where seller_uid = $1 and source_listing_id = $2
      limit 1
"#;

const UPSERT_1DR_ASSET_SQL: &str = r#"
        insert into public.marketplace_cardtrader_1dr_assets (
          seller_uid, ct_product_id, blueprint_id, card_id, card_name, set_name,
          collector_number, card_image_url, condition, language, reverse,
          first_edition, signed, altered, graded, quantity, price_pkn,
          last_seen_at, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now(), now())
        on conflict (seller_uid, ct_product_id) do update set
          blueprint_id = excluded.blueprint_id,
          card_id = excluded.card_id,
          card_name = excluded.card_name,
          set_name = excluded.set_name,
          collector_number = excluded.collector_number,
          card_image_url = excluded.card_image_url,
          condition = excluded.condition,
          language = excluded.language,
          reverse = excluded.reverse,
          first_edition = excluded.first_edition,
          signed = excluded.signed,
          altered = excluded.altered,
          graded = excluded.graded,
          quantity = excluded.quantity,
          price_pkn = excluded.price_pkn,
          last_seen_at = now(),
          updated_at = now()
"#;

const HIDE_IMPORTED_LISTINGS_SQL: &str = r#"
      update public.marketplace_user_listings
      set status = 'inactive', updated_at = now()
      where seller_uid = $1
        and source = $2
        and source_listing_id like 'ct:%'
        and status <> 'inactive'
        and ($3::boolean is false or status <> 'sold_out')
      returning id, card_id
"#;

const READ_1DR_ASSETS_SQL: &str = r#"
      select ct_product_id, blueprint_id, card_id, card_name, set_name,
             collector_number, card_image_url, condition, language, reverse,
             first_edition, signed, altered, graded, quantity, price_pkn, updated_at
      from public.marketplace_cardtrader_1dr_assets
      where seller_uid = $1 and quantity > 0
      order by price_pkn * quantity desc, card_name asc
      limit $2
"#;

const SOLD_BY_BLUEPRINT_SQL: &str = r#"
        select
          source_item_id::text as source_item_id,
          blueprint_id::text as blueprint_id,
          sale_day,
          sale_price_pkn as pkn,
          quantity
        from public.marketplace_sold_digest
        where blueprint_id::text = any($1::text[])
        order by sale_day desc
        limit 2000
"#;

pub async fn load_seller_listings(db: &DbPools, seller_uid: &str) -> ApiResult<Vec<ListingRow>> {
    let rows = db.query("pokemon", LOAD_SELLER_LISTINGS_SQL, &[json!(seller_uid)]).await?;
    Ok(rows.iter().map(listing_row).collect())
}

/// CardTrader product id → its product link's `missing_from_ct`.
pub async fn load_link_missing_flags(db: &DbPools, seller_uid: &str) -> ApiResult<HashMap<String, bool>> {
    match db.query("pokemon", LOAD_PRODUCT_LINKS_SQL, &[json!(seller_uid)]).await {
        Ok(rows) => Ok(rows
            .iter()
            .map(|link| {
                (
                    clean_text_value(link.get("ct_product_id").unwrap_or(&Value::Null), 80),
                    link.get("missing_from_ct") == Some(&Value::Bool(true)),
                )
            })
            .collect()),
        Err(error) if error.is_table_missing() => Ok(HashMap::new()),
        Err(error) => Err(error),
    }
}

pub async fn upsert_product_link(
    db: &DbPools,
    seller_uid: &str,
    ct_product_id: &str,
    listing_id: &str,
    blueprint_id: &str,
    quantity: i64,
    origin: &str,
    missing_from_ct: bool,
) -> ApiResult<()> {
    match db
        .write(
            "pokemon",
            UPSERT_PRODUCT_LINK_SQL,
            &[
                json!(seller_uid),
                json!(ct_product_id),
                json!(listing_id),
                json!(if blueprint_id.is_empty() { String::new() } else { blueprint_id.to_string() }),
                json!(quantity),
                json!(origin),
                json!(missing_from_ct),
            ],
        )
        .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.is_table_missing() => Ok(()),
        Err(error) => Err(error),
    }
}

pub async fn record_seller_sync(
    db: &DbPools,
    seller_uid: &str,
    ok: bool,
    incomplete: bool,
    error: &str,
    summary: &Value,
    export_count: i64,
    complete: bool,
) -> ApiResult<()> {
    match db
        .write(
            "pokemon",
            RECORD_SELLER_SYNC_SQL,
            &[
                json!(seller_uid),
                json!(ok),
                json!(incomplete),
                json!(clean_text(Some(if error.is_empty() { "" } else { error }), 500)),
                json!(summary.to_string()),
                json!(complete),
                json!(export_count),
            ],
        )
        .await
    {
        Ok(_) => Ok(()),
        Err(err) if err.is_table_missing() => Ok(()),
        Err(err) => Err(err),
    }
}

pub async fn read_seller_sync(db: &DbPools, seller_uid: &str) -> ApiResult<Option<Value>> {
    match db.query("pokemon", READ_SELLER_SYNC_SQL, &[json!(seller_uid)]).await {
        Ok(rows) => Ok(rows.first().cloned()),
        Err(error) if error.is_table_missing() => Ok(None),
        Err(error) => Err(error),
    }
}

/// `cardMetadataMany` — batch catalog metadata, scoped per game.
pub async fn card_metadata_many(db: &DbPools, card_ids: &[String], game: &str) -> Value {
    let ids: Vec<String> = card_ids
        .iter()
        .map(|id| clean_text(Some(id), 80))
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>()
        .into_iter()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return json!({});
    }
    let game = crate::db::normalize_game(game);
    let fallback = if game == "pokemon" { "Pokemon".to_string() } else { game.clone() };
    match db
        .query(&game, CARD_METADATA_MANY_SQL, &[json!(ids), json!(fallback)])
        .await
    {
        Ok(rows) => {
            let mut map = serde_json::Map::new();
            for row in rows {
                let key = clean_text_value(row.get("card_id").unwrap_or(&Value::Null), 80);
                map.insert(key, row);
            }
            Value::Object(map)
        }
        Err(error) => {
            tracing::warn!(game = %game, "cardtrader batch metadata lookup failed: {}", error.message);
            json!({})
        }
    }
}

/// `applyCtQuantity` — absolute CT quantity minus checkout holds.
pub async fn apply_ct_quantity(db: &DbPools, listing_id: &str, quantity: i64) -> ApiResult<Option<Value>> {
    apply_ct_quantity_since(db, listing_id, quantity, None).await
}

/// `apply_ct_quantity` for a quantity read from an export fetched at
/// `export_started_at` (writer clock). A row written after that instant (a
/// webhook decrement, a checkout) may only go down: raising it would put back
/// stock the export never saw sold (specs/tla/ct-reconcile NoStaleResurrection).
/// `None` when the row is not CardTrader-linked or the raise was refused.
pub async fn apply_ct_quantity_since(
    db: &DbPools,
    listing_id: &str,
    quantity: i64,
    export_started_at: Option<&str>,
) -> ApiResult<Option<Value>> {
    let qty = quantity.clamp(0, 999_999);
    let since = export_started_at.map(|at| json!(at)).unwrap_or(Value::Null);
    let rows = db
        .write("pokemon", APPLY_CT_QUANTITY_SQL, &[json!(listing_id), json!(qty), since])
        .await?;
    Ok(rows.first().cloned())
}

/// The writer's clock, the same clock that stamps `updated_at`.
pub async fn writer_clock(db: &DbPools) -> Option<String> {
    match db.write("pokemon", "select clock_timestamp()::text as now", &[]).await {
        Ok(rows) => rows
            .first()
            .and_then(|row| row.get("now"))
            .and_then(Value::as_str)
            .map(str::to_string),
        Err(error) => {
            tracing::warn!("cardtrader reconcile writer clock unavailable: {}", error.message);
            None
        }
    }
}

/// Advisory-lock key serialising imports of one CardTrader product.
pub fn import_lock_key(seller_uid: &str, source_listing_id: &str) -> String {
    format!("ct-import:{seller_uid}:{source_listing_id}")
}

/// `delistCtListing` — seller removed it on CardTrader: inactive, not sold.
pub async fn delist_ct_listing(db: &DbPools, listing_id: &str) -> ApiResult<Option<Value>> {
    let rows = db.write("pokemon", DELIST_CT_LISTING_SQL, &[json!(listing_id)]).await?;
    Ok(rows.first().cloned())
}

/// `linkExistingListing` — attach a pokoin-only listing to the CT product.
pub async fn link_existing_listing(db: &DbPools, listing_id: &str, product: &NormalizedProduct) -> ApiResult<Option<Value>> {
    let source_listing_id = ct_source_listing_id(&product.id);
    let qty = product.quantity.clamp(0, 999_999);
    let sql = if product.price_pkn.unwrap_or(0.0) > 0.0 {
        LINK_EXISTING_LISTING_SQL.replace("{price_sql}", ", price_pkn = $4")
    } else {
        LINK_EXISTING_LISTING_SQL.replace("{price_sql}", "")
    };
    let mut params = vec![json!(listing_id), json!(source_listing_id), json!(qty)];
    if product.price_pkn.unwrap_or(0.0) > 0.0 {
        params.push(json!(product.price_pkn));
    }
    let rows = db.write("pokemon", &sql, &params).await?;
    Ok(rows.first().cloned())
}

/// `createImportedListing` — new listing row for a CT product.
#[allow(clippy::too_many_arguments)]
pub async fn create_imported_listing(
    db: &DbPools,
    seller_uid: &str,
    seller_name: &str,
    seller_country: &str,
    product: &NormalizedProduct,
    card_id: &str,
    marketplace_game: &str,
    reactivate_hidden: bool,
    meta: &Value,
    location: &str,
) -> ApiResult<Option<Value>> {
    let qty = product.quantity.clamp(0, 999_999);
    let price_pkn = product.price_pkn;
    let Some(price_pkn) = price_pkn.filter(|p| *p > 0.0) else {
        return Err(ApiError::new(500, "CardTrader product has no usable price.").with_code("no_price"));
    };
    if qty <= 0 {
        return Err(ApiError::new(500, "CardTrader product quantity is zero.").with_code("zero_qty"));
    }
    let source_listing_id = ct_source_listing_id(&product.id);
    let country = clean_text(Some(seller_country), 2).to_uppercase();
    let country_code = if country.len() == 2 && country.chars().all(|c| c.is_ascii_uppercase()) && country != "EU" {
        country
    } else {
        String::new()
    };
    let stock_location = clean_text(Some(location), 120);

    // Find-then-insert runs in one writer transaction under an advisory lock
    // on (seller, product): two reconcilers (Redis lock expired or Redis down)
    // used to both miss the row and both insert (specs/tla/ct-reconcile
    // UniqueLink). The find reads the writer, never the lagging replica.
    let mut tx = db.writer()?.begin().await?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(import_lock_key(seller_uid, &source_listing_id))
        .execute(&mut *tx)
        .await?;
    let find_params = [json!(seller_uid), json!(source_listing_id)];
    let existing = rows_to_json(&bound_query(FIND_EXISTING_BY_SOURCE_SQL, &find_params).fetch_all(&mut *tx).await?);
    if let Some(found) = existing.first().cloned() {
        let found_status = clean_text_value(found.get("status").unwrap_or(&Value::Null), 40);
        let found_location = clean_text_value(found.get("location").unwrap_or(&Value::Null), 120);
        let write = if found_status == "inactive" && reactivate_hidden {
            Some((REACTIVATE_HIDDEN_SQL, vec![found["id"].clone(), json!(qty), json!(price_pkn), json!(stock_location)]))
        } else if !stock_location.is_empty() && found_location.is_empty() {
            Some((PATCH_LOCATION_IF_EMPTY_SQL, vec![found["id"].clone(), json!(stock_location)]))
        } else {
            None
        };
        let row = match write {
            Some((sql, params)) => rows_to_json(&bound_query(sql, &params).fetch_all(&mut *tx).await?).first().cloned(),
            None => None,
        };
        tx.commit().await?;
        return Ok(row.or(Some(found)));
    }

    let card_name = if !product.name.is_empty() {
        product.name.clone()
    } else {
        clean_text_value(meta.get("card_name").unwrap_or(&Value::Null), 240)
    };
    let set_name = {
        let from_meta = clean_text_value(meta.get("set_name").unwrap_or(&Value::Null), 240);
        if !from_meta.is_empty() {
            from_meta
        } else if marketplace_game == "pokemon" {
            "Pokemon".to_string()
        } else {
            marketplace_game.to_string()
        }
    };
    let game = if marketplace_game.is_empty() { "pokemon" } else { marketplace_game };
    // Every game's seller listings live in the shared marketplace writer
    // (marketplace_game column), as in Node. The port wrote non-Pokemon
    // imports to the per-game writer, which load_seller_listings never reads,
    // so the product was imported again on every run.
    let insert_params = [
        json!(card_id),
        json!(seller_uid),
        json!(if clean_text(Some(seller_name), 120).is_empty() { "Pokoin seller".to_string() } else { clean_text(Some(seller_name), 120) }),
        json!(country_code),
        json!(product.condition),
        json!(product.language),
        json!(price_pkn),
        json!(qty),
        json!(product.signed),
        json!(product.reverse),
        json!(product.first_edition),
        json!(if product.reverse { "reverse" } else { "standard" }),
        json!(product.graded),
        json!(if product.description.is_empty() { String::new() } else { product.description.clone() }),
        json!(SOURCE_IMPORT),
        json!(source_listing_id),
        json!(if card_name.is_empty() { card_id.to_string() } else { card_name }),
        json!(clean_text_value(meta.get("card_image_url").unwrap_or(&Value::Null), 800)),
        json!(set_name),
        json!(clean_text_value(meta.get("collector_number").unwrap_or(&Value::Null), 80)),
        json!(product.altered),
        json!(game),
        json!(stock_location),
    ];
    let rows = rows_to_json(&bound_query(CREATE_IMPORTED_LISTING_SQL, &insert_params).fetch_all(&mut *tx).await?);
    tx.commit().await?;
    Ok(rows.first().cloned())
}

/// `hideImportedCardTraderListings` — disconnect/1-DR hide path.
pub async fn hide_imported_cardtrader_listings(db: &DbPools, seller_uid: &str, keep_sold_out: bool) -> ApiResult<i64> {
    let rows = db
        .write(
            "pokemon",
            HIDE_IMPORTED_LISTINGS_SQL,
            &[json!(seller_uid), json!(SOURCE_IMPORT), json!(keep_sold_out)],
        )
        .await?;
    let _ = db
        .write(
            "pokemon",
            "delete from public.marketplace_cardtrader_product_links where seller_uid = $1 and origin = 'import'",
            &[json!(seller_uid)],
        )
        .await;
    let mut seen = std::collections::HashSet::new();
    for row in &rows {
        let card_id = clean_text_value(row.get("card_id").unwrap_or(&Value::Null), 80);
        if !card_id.is_empty() && seen.insert(card_id.clone()) {
            let _ = db
                .write("pokemon", "select public.refresh_marketplace_blueprint_price_summary($1)", &[json!(card_id)])
                .await;
        }
    }
    Ok(rows.len() as i64)
}

pub async fn read_one_day_ready_assets(db: &DbPools, seller_uid: &str, limit: i64) -> ApiResult<Vec<Value>> {
    let bounded = limit.clamp(1, 2000);
    match db.query("pokemon", READ_1DR_ASSETS_SQL, &[json!(seller_uid), json!(bounded)]).await {
        Ok(rows) => Ok(rows),
        Err(error) if error.is_table_missing() => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// `soldPriceBook`/`lastSoldFor` collapsed: last sale row per blueprint.
fn last_sold_book(rows: &[Value]) -> std::collections::HashMap<String, (String, f64)> {
    let mut book = std::collections::HashMap::new();
    for row in rows {
        let blueprint = clean_text_value(row.get("blueprint_id").unwrap_or(&Value::Null), 80);
        let day = clean_text_value(row.get("sale_day").unwrap_or(&Value::Null), 40);
        let pkn = row.get("pkn").and_then(Value::as_f64).unwrap_or(0.0);
        if blueprint.is_empty() {
            continue;
        }
        let entry = book.entry(blueprint).or_insert((day.clone(), pkn));
        if *entry.0.as_bytes().first().unwrap_or(&0) != 0 && day > entry.0 {
            *entry = (day, pkn);
        }
    }
    book
}

/// The full reconcile (`reconcileCardTraderInventory`).
pub struct ReconcileArgs<'a> {
    pub firestore: &'a dyn FirestoreStore,
    pub db: &'a DbPools,
    pub ct: &'a CardTraderClient,
    pub uid: &'a str,
    pub seller_name: String,
    pub token: Option<String>,
    pub one_day_ready: Option<bool>,
    pub on_progress: Option<Box<dyn Fn(Value) + Send + Sync>>,
    pub power_tools_by_game: Option<Value>,
    pub preview_games_only: bool,
}

pub async fn reconcile_cardtrader_inventory(args: ReconcileArgs<'_>) -> ApiResult<Value> {
    let ReconcileArgs { firestore, db, ct, uid, seller_name, token, one_day_ready, on_progress, power_tools_by_game: _, preview_games_only } = args;
    let emit = |partial: Value| {
        if let Some(callback) = &on_progress {
            callback(partial);
        }
    };
    let mut summary = empty_summary();
    let seller_uid = clean_text(Some(uid), 160);
    if seller_uid.is_empty() {
        return Err(ApiError::bad_request("Missing seller uid."));
    }

    let token = match token {
        Some(token) => token,
        None => match ct_integration::decrypt_integration_token(firestore, &seller_uid).await {
            Ok(token) => token,
            Err(error) => {
                let _ = record_seller_sync(db, &seller_uid, false, true, &error.message, &summary, 0, false).await;
                return Ok(json!({
                    "ok": false, "incomplete": true, "connected": false,
                    "destructiveSkipped": true,
                    "error": if error.message.is_empty() { "CardTrader is not connected.".to_string() } else { error.message.clone() },
                    "summary": summary,
                }));
            }
        },
    };

    let mut seller_country = String::new();
    if let Ok(user) = firestore.get_doc("users", &seller_uid).await {
        if user.exists {
            let raw = clean_text_value(user.data.get("shipFromCountry").unwrap_or(&Value::Null), 2).to_uppercase();
            if raw.len() == 2 && raw.chars().all(|c| c.is_ascii_uppercase()) && raw != "EU" {
                seller_country = raw;
            }
        }
    }

    // Account type decides where the stock goes.
    let one_day_ready = match one_day_ready {
        Some(flag) => flag,
        None => match ct.validate_token(&token).await {
            Ok(info) => {
                let ready = info.get("oneDayReady") == Some(&Value::Bool(true));
                let _ = ct_integration::mark_one_day_ready(firestore, &seller_uid, ready).await;
                ready
            }
            Err(error) => {
                let _ = record_seller_sync(db, &seller_uid, false, true, &error.message, &summary, 0, false).await;
                return Ok(json!({
                    "ok": false, "incomplete": true, "connected": true,
                    "destructiveSkipped": true,
                    "error": if error.message.is_empty() { "CardTrader account check failed.".to_string() } else { error.message.clone() },
                    "summary": summary,
                }));
            }
        },
    };

    emit(json!({ "phase": "export", "processed": 0, "total": 0 }));

    // Taken before the export request: rows written after it may only go down.
    let export_started_at = writer_clock(db).await;
    let export = match ct.fetch_products_export(&token).await {
        Ok(export) => export,
        Err(error) => {
            summary["errors"].incr(1);
            summary["errorItems"].as_array_mut().unwrap().push(json!({ "reason": if error.message.is_empty() { "export_failed".to_string() } else { error.message.clone() } }));
            let _ = record_seller_sync(db, &seller_uid, false, true, &error.message, &summary, 0, false).await;
            return Ok(json!({
                "ok": false, "incomplete": true, "connected": true, "destructiveSkipped": true,
                "error": if error.message.is_empty() { "CardTrader inventory export failed.".to_string() } else { error.message.clone() },
                "summary": summary,
            }));
        }
    };

    let products = &export.products;
    // A row whose id was not understood makes the export unable to say what
    // is absent: no destructive step (1-Day Ready asset deletes included).
    let (allow_destructive, gate_reason) = if export.unparsed_rows > 0 {
        (false, "unparsed_export")
    } else {
        destructive_reconcile_gate(true, true, true)
    };
    summary["inventory"].set_i64(products.len() as i64);

    if preview_games_only {
        let mut games: serde_json::Map<String, Value> = serde_json::Map::new();
        for product in products {
            let game = marketplace_game_for_product(product);
            if game.is_empty() {
                continue;
            }
            games.entry(game.to_string()).or_insert(json!(0)).incr(1);
        }
        let games: Value = games
            .into_iter()
            .map(|(id, count)| json!({ "id": id, "count": count }))
            .collect::<Vec<_>>()
            .into();
        let mut preview = summary.clone();
        preview["running"] = json!(false);
        preview["phase"] = json!("preview_games");
        preview["games"] = games.clone();
        preview["previewGamesOnly"] = json!(true);
        return Ok(json!({ "ok": true, "connected": true, "previewGamesOnly": true, "games": games, "summary": preview }));
    }

    if one_day_ready {
        return reconcile_one_day_ready_assets(db, firestore, ct, &seller_uid, products, allow_destructive, gate_reason, &mut summary, &emit, &token).await;
    }

    reconcile_linked_listings(
        &PgReconcileStore(db),
        firestore,
        ct,
        &token,
        &seller_uid,
        &seller_name,
        &seller_country,
        &export,
        export_started_at.as_deref(),
        &emit,
    )
    .await
}

/// The Postgres reads and writes of the standard (not 1-Day Ready)
/// reconcile, as a trait so the executor runs against an in-memory store in
/// tests. [`PgReconcileStore`] is the production one.
pub(crate) trait ReconcileStore: Send + Sync {
    fn seller_listings<'a>(&'a self, seller_uid: &'a str) -> BoxFuture<'a, ApiResult<Vec<ListingRow>>>;
    fn link_missing_flags<'a>(&'a self, seller_uid: &'a str) -> BoxFuture<'a, ApiResult<HashMap<String, bool>>>;
    fn card_metadata<'a>(&'a self, card_ids: &'a [String]) -> BoxFuture<'a, Value>;
    fn apply_quantity<'a>(&'a self, listing_id: &'a str, quantity: i64, export_started_at: Option<&'a str>) -> BoxFuture<'a, ApiResult<Option<Value>>>;
    fn link_listing<'a>(&'a self, listing_id: &'a str, product: &'a NormalizedProduct) -> BoxFuture<'a, ApiResult<Option<Value>>>;
    #[allow(clippy::too_many_arguments)]
    fn import_listing<'a>(
        &'a self,
        seller_uid: &'a str,
        seller_name: &'a str,
        seller_country: &'a str,
        product: &'a NormalizedProduct,
        card_id: &'a str,
        reactivate_hidden: bool,
        meta: &'a Value,
    ) -> BoxFuture<'a, ApiResult<Option<Value>>>;
    fn delist<'a>(&'a self, listing_id: &'a str) -> BoxFuture<'a, ApiResult<Option<Value>>>;
    #[allow(clippy::too_many_arguments)]
    fn upsert_link<'a>(
        &'a self,
        seller_uid: &'a str,
        ct_product_id: &'a str,
        listing_id: &'a str,
        blueprint_id: &'a str,
        quantity: i64,
        origin: &'a str,
        missing_from_ct: bool,
    ) -> BoxFuture<'a, ApiResult<()>>;
    #[allow(clippy::too_many_arguments)]
    fn record_sync<'a>(
        &'a self,
        seller_uid: &'a str,
        ok: bool,
        incomplete: bool,
        error: &'a str,
        summary: &'a Value,
        export_count: i64,
        complete: bool,
    ) -> BoxFuture<'a, ApiResult<()>>;
}

pub(crate) struct PgReconcileStore<'d>(pub &'d DbPools);

impl ReconcileStore for PgReconcileStore<'_> {
    fn seller_listings<'a>(&'a self, seller_uid: &'a str) -> BoxFuture<'a, ApiResult<Vec<ListingRow>>> {
        Box::pin(load_seller_listings(self.0, seller_uid))
    }

    fn link_missing_flags<'a>(&'a self, seller_uid: &'a str) -> BoxFuture<'a, ApiResult<HashMap<String, bool>>> {
        Box::pin(load_link_missing_flags(self.0, seller_uid))
    }

    fn card_metadata<'a>(&'a self, card_ids: &'a [String]) -> BoxFuture<'a, Value> {
        Box::pin(card_metadata_many(self.0, card_ids, "pokemon"))
    }

    fn apply_quantity<'a>(&'a self, listing_id: &'a str, quantity: i64, export_started_at: Option<&'a str>) -> BoxFuture<'a, ApiResult<Option<Value>>> {
        Box::pin(apply_ct_quantity_since(self.0, listing_id, quantity, export_started_at))
    }

    fn link_listing<'a>(&'a self, listing_id: &'a str, product: &'a NormalizedProduct) -> BoxFuture<'a, ApiResult<Option<Value>>> {
        Box::pin(link_existing_listing(self.0, listing_id, product))
    }

    fn import_listing<'a>(
        &'a self,
        seller_uid: &'a str,
        seller_name: &'a str,
        seller_country: &'a str,
        product: &'a NormalizedProduct,
        card_id: &'a str,
        reactivate_hidden: bool,
        meta: &'a Value,
    ) -> BoxFuture<'a, ApiResult<Option<Value>>> {
        Box::pin(create_imported_listing(
            self.0,
            seller_uid,
            seller_name,
            seller_country,
            product,
            card_id,
            marketplace_game_for_product(product),
            reactivate_hidden,
            meta,
            "",
        ))
    }

    fn delist<'a>(&'a self, listing_id: &'a str) -> BoxFuture<'a, ApiResult<Option<Value>>> {
        Box::pin(delist_ct_listing(self.0, listing_id))
    }

    fn upsert_link<'a>(
        &'a self,
        seller_uid: &'a str,
        ct_product_id: &'a str,
        listing_id: &'a str,
        blueprint_id: &'a str,
        quantity: i64,
        origin: &'a str,
        missing_from_ct: bool,
    ) -> BoxFuture<'a, ApiResult<()>> {
        Box::pin(upsert_product_link(self.0, seller_uid, ct_product_id, listing_id, blueprint_id, quantity, origin, missing_from_ct))
    }

    fn record_sync<'a>(
        &'a self,
        seller_uid: &'a str,
        ok: bool,
        incomplete: bool,
        error: &'a str,
        summary: &'a Value,
        export_count: i64,
        complete: bool,
    ) -> BoxFuture<'a, ApiResult<()>> {
        Box::pin(record_seller_sync(self.0, seller_uid, ok, incomplete, error, summary, export_count, complete))
    }
}

/// Counters of applied actions. The plan counts what it means to do; these
/// count what was done, once each (the job logged "removed: 800" for 400
/// removals: the plan's count plus the destructive pass's).
const APPLIED_COUNTERS: [&str; 3] = ["updated", "matchedExisting", "removed"];

/// The standard reconcile of a fetched export: plan, apply, then the
/// destructive pass for linked products that left the export.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn reconcile_linked_listings(
    store: &dyn ReconcileStore,
    firestore: &dyn FirestoreStore,
    ct: &CardTraderClient,
    token: &str,
    seller_uid: &str,
    seller_name: &str,
    seller_country: &str,
    export: &ProductsExport,
    export_started_at: Option<&str>,
    emit: &(dyn Fn(Value) + Send + Sync),
) -> ApiResult<Value> {
    let listings = store.seller_listings(seller_uid).await?;
    let link_missing = store.link_missing_flags(seller_uid).await?;

    let plan = plan_inventory_reconcile(export, &listings, &link_missing, true, true);
    let mut summary = plan.summary.clone();
    for key in APPLIED_COUNTERS {
        summary[key] = json!(0);
    }

    // First row wins on a duplicate id, as the linear find did.
    let mut product_by_id: HashMap<&str, &NormalizedProduct> = HashMap::with_capacity(export.products.len());
    for product in &export.products {
        product_by_id.entry(product.id.as_str()).or_insert(product);
    }

    emit(json!({ "phase": "export_done", "processed": 0, "total": plan.actions.len() }));

    // Batch metadata for imports (per game).
    let import_card_ids: Vec<String> = plan
        .actions
        .iter()
        .filter_map(|action| match action {
            PlannedAction::Import { card_id, .. } if !card_id.is_empty() => Some(card_id.clone()),
            _ => None,
        })
        .collect();
    let meta_by_card = store.card_metadata(&import_card_ids).await;

    emit(json!({ "phase": "import", "processed": 0, "total": plan.actions.len(), "inventory": summary["inventory"], "pokemonInventory": summary["pokemonInventory"] }));

    let mut processed = 0i64;
    for action in &plan.actions {
        let result: ApiResult<()> = async {
            match action {
                PlannedAction::Unresolved { product_id, reason } => {
                    summary["unresolved"].incr(1);
                    summary["unresolvedItems"].as_array_mut().unwrap().push(json!({ "ctProductId": product_id, "reason": reason }));
                    Ok(())
                }
                PlannedAction::Noop { .. } => Ok(()),
                PlannedAction::UpdateQty { product_id: _, listing_id, quantity } => {
                    if store.apply_quantity(listing_id, *quantity, export_started_at).await?.is_none() {
                        // Written after the export was taken (webhook, checkout):
                        // the next complete export settles it.
                        ensure_counter(&mut summary, "staleSkipped", 1);
                        return Ok(());
                    }
                    summary["updated"].incr(1);
                    Ok(())
                }
                PlannedAction::Link { product_id, listing_id } => {
                    if let Some(product) = product_by_id.get(product_id.as_str()) {
                        let updated = store.link_listing(listing_id, product).await?;
                        if updated.is_none() {
                            summary["errors"].incr(1);
                            summary["errorItems"].as_array_mut().unwrap().push(json!({ "ctProductId": product_id, "reason": "link_failed" }));
                            return Ok(());
                        }
                        summary["matchedExisting"].incr(1);
                        store.upsert_link(seller_uid, product_id, listing_id, &product.blueprint_id, product.quantity, "match", false).await?;
                    }
                    Ok(())
                }
                PlannedAction::Import { product_id, card_id, .. } => {
                    if let Some(product) = product_by_id.get(product_id.as_str()) {
                        let reactivate = link_missing.get(product_id).copied().unwrap_or(true);
                        let meta = meta_by_card.get(card_id).cloned().unwrap_or(json!({}));
                        let created = store
                            .import_listing(seller_uid, seller_name, seller_country, product, card_id, reactivate, &meta)
                            .await?;
                        let Some(created) = created else {
                            summary["errors"].incr(1);
                            summary["errorItems"].as_array_mut().unwrap().push(json!({ "ctProductId": product_id, "reason": "import_failed" }));
                            return Ok(());
                        };
                        store
                            .upsert_link(
                                seller_uid,
                                product_id,
                                &clean_text_value(created.get("id").unwrap_or(&Value::Null), 80),
                                &product.blueprint_id,
                                product.quantity,
                                "import",
                                false,
                            )
                            .await?;
                    }
                    Ok(())
                }
                PlannedAction::Remove { .. } => Ok(()),
            }
        }
        .await;
        if let Err(error) = result {
            summary["errors"].incr(1);
            summary["errorItems"].as_array_mut().unwrap().push(json!({ "reason": error.message }));
        }
        processed += 1;
        if processed % 25 == 0 || processed == plan.actions.len() as i64 {
            emit(json!({
                "phase": "import", "processed": processed, "total": plan.actions.len(),
                "inventory": summary["inventory"], "pokemonInventory": summary["pokemonInventory"],
                "imported": summary["imported"], "updated": summary["updated"],
                "matchedExisting": summary["matchedExisting"],
            }));
        }
    }

    // Destructive pass: vanished products with sale evidence classification.
    if plan.allow_destructive {
        // (product_id, listing row) for linked listings whose product left the
        // export. Synthetic import placeholders are never removal candidates.
        let listing_by_id: HashMap<&str, &ListingRow> = listings.iter().map(|row| (row.id.as_str(), row)).collect();
        let mut vanished: Vec<(String, ListingRow)> = Vec::new();
        for action in &plan.actions {
            if let PlannedAction::Remove { product_id, listing_id, source_id } = action {
                if listing_id.starts_with("import:") {
                    continue;
                }
                let found = listing_by_id.get(listing_id.as_str());
                let row = found
                    .filter(|row| row.source_listing_id == *source_id)
                    .map(|row| (*row).clone())
                    .unwrap_or(ListingRow {
                        id: listing_id.clone(),
                        card_id: String::new(),
                        quantity_available: 0,
                        status: String::new(),
                        source_listing_id: source_id.clone(),
                        created_ms: found.and_then(|row| row.created_ms),
                    });
                vanished.push((product_id.clone(), row));
            }
        }

        // Sale evidence comes from CardTrader's own seller orders, never from
        // "it vanished from the export". No data ⇒ Unknown: take it down,
        // claim nothing. Fetched only when something newly vanished.
        let mut sales: Option<HashMap<String, Vec<(Value, Value)>>> = None;
        if !vanished.is_empty() {
            if let Ok(orders) = ct
                .fetch_seller_sale_orders(token, &sale_evidence_from(&SALE_EVIDENCE_DAYS), 100, 50)
                .await
            {
                sales = Some(sale_items_by_product(&orders));
            }
        }
        for (product_id, listing) in vanished {
            let verdict = classify_vanished_product(&product_id, listing.created_ms, sales.as_ref());
            match verdict {
                VanishedVerdict::Sold { sales: matched } => {
                    let _ = store.apply_quantity(&listing.id, 0, None).await?;
                    ensure_counter(&mut summary, "soldOnCardTrader", 1);
                    // Record missed sales once each (Firestore create = claim).
                    for (order, item) in matched {
                        let id = crate::cardtrader::webhook::event_doc_id(
                            seller_uid,
                            &clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
                            &crate::cardtrader::webhook::order_item_id(&item),
                        );
                        match firestore
                            .create_doc(
                                crate::cardtrader::webhook::EVENTS_COLLECTION,
                                &id,
                                json!({
                                    "uid": seller_uid,
                                    "orderId": clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
                                    "orderItemId": crate::cardtrader::webhook::order_item_id(&item),
                                    "cause": "reconcile",
                                    "listingId": listing.id,
                                    "quantity": i64_field(&item, &["quantity"]).unwrap_or(1).max(1),
                                    "productId": crate::error::clean_text_value(item.get("product_id").unwrap_or(&Value::Null), 80),
                                    "createdAt": crate::time_util::iso_from_ms(crate::time_util::now_ms()),
                                }),
                            )
                            .await
                        {
                            Ok(()) => {
                                let _ = crate::cardtrader::webhook::record_cardtrader_sale(
                                    firestore,
                                    seller_uid,
                                    &order,
                                    &item,
                                    &json!({ "id": listing.id, "card_id": listing.card_id }),
                                    "",
                                )
                                .await;
                            }
                            Err(_) => {}
                        }
                    }
                }
                VanishedVerdict::Delisted | VanishedVerdict::Unknown => {
                    let _ = store.delist(&listing.id).await?;
                    ensure_counter(&mut summary, "delisted", 1);
                }
            }
            summary["removed"].incr(1);
            store.upsert_link(seller_uid, &product_id, &listing.id, "", 0, "import", true).await?;
        }
    }

    emit(json!({
        "phase": "finishing", "processed": plan.actions.len(), "total": plan.actions.len(),
        "inventory": summary["inventory"], "pokemonInventory": summary["pokemonInventory"],
    }));

    let mut persisted = summary.clone();
    persisted["running"] = json!(false);
    persisted["phase"] = json!("done");
    persisted["processed"] = json!(plan.actions.len());
    persisted["unresolvedItems"] = truncate_array(&persisted["unresolvedItems"], 25);
    persisted["errorItems"] = truncate_array(&persisted["errorItems"], 25);

    // The plan's gate, not the HTTP one: an unparsed export or a blocked mass
    // removal is an incomplete sync that the periodic job must report.
    let (allow_destructive, gate_reason) = (plan.allow_destructive, plan.gate_reason);
    store
        .record_sync(
            seller_uid,
            persisted["errors"].as_i64().unwrap_or(0) == 0,
            !allow_destructive,
            if allow_destructive { "" } else { gate_reason },
            &persisted,
            summary["inventory"].as_i64().unwrap_or(0),
            allow_destructive,
        )
        .await?;

    Ok(json!({
        "ok": true,
        "incomplete": !allow_destructive,
        "connected": true,
        "complete": allow_destructive,
        "destructiveSkipped": !allow_destructive,
        "gateReason": gate_reason,
        "summary": persisted,
    }))
}

fn ensure_counter(summary: &mut Value, key: &str, delta: i64) {
    let current = summary.get(key).and_then(Value::as_i64).unwrap_or(0);
    summary[key] = json!(current + delta);
}

fn truncate_array(value: &Value, limit: usize) -> Value {
    match value.as_array() {
        Some(rows) => Value::Array(rows.iter().take(limit).cloned().collect()),
        None => json!([]),
    }
}

fn sale_evidence_from(days: &i64) -> String {
    let from_ms = crate::time_util::now_ms() - days * 86_400_000;
    crate::time_util::utc_day_key_from_ms(from_ms)
}

/// Start day of the 1-Day Ready order read: two days before the last
/// successful sync (late-confirmed orders still land), never older than the
/// evidence window. A first sync, or an unreadable record, reads the window.
fn incremental_evidence_from(last_ok_sync_ms: Option<i64>, now_ms: i64) -> String {
    let window_ms = now_ms - SALE_EVIDENCE_DAYS * 86_400_000;
    let from_ms = last_ok_sync_ms
        .map(|ms| (ms - 2 * 86_400_000).max(window_ms))
        .unwrap_or(window_ms);
    crate::time_util::utc_day_key_from_ms(from_ms)
}

async fn last_ok_sync_ms(db: &DbPools, seller_uid: &str) -> Option<i64> {
    let row = read_seller_sync(db, seller_uid).await.ok().flatten()?;
    if row.get("last_sync_ok") != Some(&Value::Bool(true)) {
        return None;
    }
    crate::time_util::ms_from_iso(row.get("last_sync_at")?.as_str()?)
}

/// 1-Day Ready pass: assets table + hide public copies + record 1dr sales.
#[allow(clippy::too_many_arguments)]
async fn reconcile_one_day_ready_assets(
    db: &DbPools,
    firestore: &dyn FirestoreStore,
    ct: &CardTraderClient,
    seller_uid: &str,
    products: &[NormalizedProduct],
    allow_destructive: bool,
    gate_reason: &str,
    summary: &mut Value,
    emit: &(dyn Fn(Value) + Send + Sync),
    token: &str,
) -> ApiResult<Value> {
    summary["mode"] = json!("one_day_ready");
    summary["assets"] = json!(0);
    summary["assetCards"] = json!(0);
    summary["assetValuePkn"] = json!(0);
    summary["hiddenListings"] = json!(0);

    let mut pokemon_products = Vec::new();
    for product in products {
        if !is_pokemon_product(product) {
            summary["skippedNonPokemon"].incr(1);
            continue;
        }
        summary["pokemonInventory"].incr(1);
        pokemon_products.push(product);
    }

    emit(json!({
        "phase": "import", "processed": 0, "total": pokemon_products.len(),
        "inventory": summary["inventory"], "pokemonInventory": summary["pokemonInventory"],
    }));

    let card_ids: Vec<String> = pokemon_products
        .iter()
        .map(|p| public_card_id_from_blueprint(&p.blueprint_id).unwrap_or_default())
        .collect();
    let meta_by_card = card_metadata_many(db, &card_ids, "pokemon").await;

    let mut rows: Vec<Value> = Vec::new();
    let mut processed = 0i64;
    for product in &pokemon_products {
        let card_id = public_card_id_from_blueprint(&product.blueprint_id).unwrap_or_default();
        let meta = meta_by_card.get(&card_id).cloned().unwrap_or(json!({}));
        let row = one_day_ready_asset_row(product, &card_id, &meta);
        let write = db
            .write(
                "pokemon",
                UPSERT_1DR_ASSET_SQL,
                &[
                    json!(seller_uid),
                    row["ctProductId"].clone(),
                    row["blueprintId"].clone(),
                    row["cardId"].clone(),
                    row["cardName"].clone(),
                    row["setName"].clone(),
                    row["collectorNumber"].clone(),
                    row["cardImageUrl"].clone(),
                    row["condition"].clone(),
                    row["language"].clone(),
                    row["reverse"].clone(),
                    row["firstEdition"].clone(),
                    row["signed"].clone(),
                    row["altered"].clone(),
                    row["graded"].clone(),
                    row["quantity"].clone(),
                    row["pricePkn"].clone(),
                ],
            )
            .await;
        match write {
            Ok(_) => rows.push(row),
            Err(error) => {
                summary["errors"].incr(1);
                summary["errorItems"].as_array_mut().unwrap().push(json!({ "ctProductId": product.id, "reason": error.message }));
            }
        }
        processed += 1;
        if processed == pokemon_products.len() as i64 || processed % 25 == 0 {
            emit(json!({
                "phase": "import", "processed": processed, "total": pokemon_products.len(),
                "inventory": summary["inventory"], "pokemonInventory": summary["pokemonInventory"],
            }));
        }
    }

    // Only a complete, error-free pass may delete assets CardTrader no longer has.
    if allow_destructive && summary["errors"].as_i64() == Some(0) {
        let keep: Vec<Value> = rows.iter().map(|row| row["ctProductId"].clone()).collect();
        let removed = db
            .write(
                "pokemon",
                "delete from public.marketplace_cardtrader_1dr_assets where seller_uid = $1 and not (ct_product_id = any($2::text[]))",
                &[json!(seller_uid), json!(keep)],
            )
            .await?
            .len() as i64;
        summary["removed"].set_i64(removed);
    }
    let hidden = hide_imported_cardtrader_listings(db, seller_uid, false).await.unwrap_or(0);
    summary["hiddenListings"] = json!(hidden);
    let totals = one_day_ready_totals(&rows);
    summary["assets"] = totals["products"].clone();
    summary["assetCards"] = totals["cards"].clone();
    summary["assetValuePkn"] = totals["valuePkn"].clone();

    // 1dr sales since the last successful sync, once each.
    let mut one_day_ready_sales = 0i64;
    let evidence_from = incremental_evidence_from(last_ok_sync_ms(db, seller_uid).await, crate::time_util::now_ms());
    if let Ok(orders) = ct
        .fetch_seller_sale_orders(token, &evidence_from, 100, 50)
        .await
    {
        let sales = sale_items_by_product(&orders);
        let mut flat: Vec<(Value, Value)> = Vec::new();
        for list in sales.values() {
            flat.extend(list.iter().cloned());
        }
        for (order, item) in flat {
            let id = crate::cardtrader::webhook::event_doc_id(
                seller_uid,
                &clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
                &crate::cardtrader::webhook::order_item_id(&item),
            );
            match firestore
                .create_doc(
                    crate::cardtrader::webhook::EVENTS_COLLECTION,
                    &id,
                    json!({
                        "uid": seller_uid,
                        "orderId": clean_text_value(order.get("id").unwrap_or(&Value::Null), 40),
                        "orderItemId": crate::cardtrader::webhook::order_item_id(&item),
                        "cause": "1dr",
                        "productId": clean_text(item.get("product_id").or_else(|| item.get("productId")).and_then(crate::error::scalar_text).as_deref(), 80),
                        "createdAt": crate::time_util::iso_from_ms(crate::time_util::now_ms()),
                    }),
                )
                .await
            {
                Ok(()) => {
                    let blueprint_id = item
                        .get("blueprint_id")
                        .or_else(|| item.get("blueprintId"))
                        .and_then(crate::error::scalar_text)
                        .unwrap_or_default();
                    let _ = crate::cardtrader::webhook::record_cardtrader_sale(
                        firestore,
                        seller_uid,
                        &order,
                        &item,
                        &json!({
                            "id": format!("ct:{}", clean_text(item.get("product_id").or_else(|| item.get("productId")).and_then(crate::error::scalar_text).as_deref(), 80)),
                            "card_id": public_card_id_from_blueprint(&blueprint_id).unwrap_or_default(),
                        }),
                        "1dr",
                    )
                    .await;
                    one_day_ready_sales += 1;
                }
                Err(error) if error.status == 409 => {}
                Err(_) => {}
            }
        }
    }
    summary["oneDayReadySales"] = json!(one_day_ready_sales);

    let mut persisted = summary.clone();
    persisted["running"] = json!(false);
    persisted["phase"] = json!("done");
    persisted["unresolvedItems"] = truncate_array(&persisted["unresolvedItems"], 25);
    persisted["errorItems"] = truncate_array(&persisted["errorItems"], 25);
    record_seller_sync(
        db,
        seller_uid,
        summary["errors"].as_i64().unwrap_or(0) == 0,
        !allow_destructive,
        if allow_destructive { "" } else { gate_reason },
        &persisted,
        summary["inventory"].as_i64().unwrap_or(0),
        allow_destructive,
    )
    .await?;
    Ok(json!({
        "ok": true,
        "oneDayReady": true,
        "incomplete": !allow_destructive,
        "connected": true,
        "complete": allow_destructive,
        "destructiveSkipped": !allow_destructive,
        "summary": persisted,
    }))
}

/// `withLastSold` pricing for the assets endpoint.
pub async fn with_last_sold(db: &DbPools, rows: Vec<Value>) -> Vec<Value> {
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("blueprint_id").map(|v| crate::error::clean_text_value(v, 40)))
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let mut book = std::collections::HashMap::new();
    if !ids.is_empty() {
        if let Ok(sold_rows) = db.query("pokemon", SOLD_BY_BLUEPRINT_SQL, &[json!(ids)]).await {
            book = last_sold_book(&sold_rows);
        }
    }
    rows.into_iter()
        .map(|mut row| {
            let blueprint = clean_text_value(row.get("blueprint_id").unwrap_or(&Value::Null), 80);
            if let Some((day, pkn)) = book.get(&blueprint) {
                row["market_pkn"] = json!(pkn);
                row["market_day"] = json!(day);
            } else {
                row["market_pkn"] = Value::Null;
                row["market_day"] = Value::Null;
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// Listings and product links in memory, written the way the SQL does.
    #[derive(Default)]
    struct MemoryStore {
        listings: Mutex<Vec<ListingRow>>,
        links: Mutex<HashMap<String, bool>>,
        writes: Mutex<Vec<String>>,
    }

    impl MemoryStore {
        fn update(&self, listing_id: &str, what: String, change: impl FnOnce(&mut ListingRow)) -> Option<Value> {
            self.writes.lock().unwrap().push(what);
            let mut listings = self.listings.lock().unwrap();
            let row = listings.iter_mut().find(|row| row.id == listing_id)?;
            change(row);
            Some(json!({ "id": row.id, "quantity_available": row.quantity_available, "status": row.status }))
        }

        fn listing(&self, id: &str) -> ListingRow {
            self.listings.lock().unwrap().iter().find(|row| row.id == id).cloned().unwrap()
        }

        fn take_writes(&self) -> Vec<String> {
            std::mem::take(&mut *self.writes.lock().unwrap())
        }
    }

    impl ReconcileStore for MemoryStore {
        fn seller_listings<'a>(&'a self, _: &'a str) -> BoxFuture<'a, ApiResult<Vec<ListingRow>>> {
            let rows: Vec<ListingRow> = self
                .listings
                .lock()
                .unwrap()
                .iter()
                .filter(|row| matches!(row.status.as_str(), "active" | "paused" | "sold_out"))
                .cloned()
                .collect();
            Box::pin(async move { Ok(rows) })
        }

        fn link_missing_flags<'a>(&'a self, _: &'a str) -> BoxFuture<'a, ApiResult<HashMap<String, bool>>> {
            let links = self.links.lock().unwrap().clone();
            Box::pin(async move { Ok(links) })
        }

        fn card_metadata<'a>(&'a self, _: &'a [String]) -> BoxFuture<'a, Value> {
            Box::pin(async { json!({}) })
        }

        fn apply_quantity<'a>(&'a self, listing_id: &'a str, quantity: i64, _: Option<&'a str>) -> BoxFuture<'a, ApiResult<Option<Value>>> {
            let row = self.update(listing_id, format!("quantity {listing_id}={quantity}"), |row| {
                let status = if quantity <= 0 {
                    "sold_out"
                } else if row.status == "sold_out" {
                    "active"
                } else {
                    row.status.as_str()
                };
                row.status = status.to_string();
                row.quantity_available = quantity.max(0);
            });
            Box::pin(async move { Ok(row) })
        }

        fn link_listing<'a>(&'a self, listing_id: &'a str, product: &'a NormalizedProduct) -> BoxFuture<'a, ApiResult<Option<Value>>> {
            let row = self.update(listing_id, format!("link {listing_id}"), |row| {
                row.source_listing_id = ct_source_listing_id(&product.id);
                row.quantity_available = product.quantity;
                row.status = "active".into();
            });
            Box::pin(async move { Ok(row) })
        }

        fn import_listing<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
            product: &'a NormalizedProduct,
            card_id: &'a str,
            _: bool,
            _: &'a Value,
        ) -> BoxFuture<'a, ApiResult<Option<Value>>> {
            let id = format!("imported-{}", product.id);
            self.writes.lock().unwrap().push(format!("import {id}"));
            self.listings.lock().unwrap().push(ListingRow {
                id: id.clone(),
                card_id: card_id.to_string(),
                quantity_available: product.quantity,
                status: "active".into(),
                source_listing_id: ct_source_listing_id(&product.id),
                created_ms: None,
            });
            Box::pin(async move { Ok(Some(json!({ "id": id }))) })
        }

        fn delist<'a>(&'a self, listing_id: &'a str) -> BoxFuture<'a, ApiResult<Option<Value>>> {
            let row = self.update(listing_id, format!("delist {listing_id}"), |row| {
                row.status = "inactive".into();
                row.quantity_available = 0;
            });
            Box::pin(async move { Ok(row) })
        }

        fn upsert_link<'a>(
            &'a self,
            _: &'a str,
            ct_product_id: &'a str,
            _: &'a str,
            _: &'a str,
            _: i64,
            _: &'a str,
            missing_from_ct: bool,
        ) -> BoxFuture<'a, ApiResult<()>> {
            self.writes.lock().unwrap().push(format!("link-row {ct_product_id} missing={missing_from_ct}"));
            self.links.lock().unwrap().insert(ct_product_id.to_string(), missing_from_ct);
            Box::pin(async { Ok(()) })
        }

        fn record_sync<'a>(&'a self, _: &'a str, _: bool, _: bool, _: &'a str, _: &'a Value, _: i64, _: bool) -> BoxFuture<'a, ApiResult<()>> {
            Box::pin(async { Ok(()) })
        }
    }

    fn linked(id: &str, product_id: u32, quantity: i64, status: &str) -> ListingRow {
        ListingRow {
            id: id.into(),
            card_id: "200".into(),
            quantity_available: quantity,
            status: status.into(),
            source_listing_id: format!("ct:{product_id}"),
            created_ms: crate::time_util::ms_from_iso("2026-09-01T00:00:00.000Z"),
        }
    }

    #[tokio::test]
    async fn sold_out_listings_settle_once_and_each_action_counts_once() {
        // CardTrader orders stand-in: product 4 sold on CardTrader after it
        // was listed. Counts every /orders fetch.
        let fetches = Arc::new(AtomicUsize::new(0));
        let orders = json!([{
            "id": 55, "code": "A1", "state": "paid", "buyer": {"email": "buyer@example.test"},
            "order_items": [{"id": 9, "product_id": 4, "quantity": 1, "name": "Pikachu",
                             "created_at": "2026-10-01T00:00:00.000Z", "seller_price": {"cents": 100, "currency": "EUR"}}],
        }]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let counter = fetches.clone();
        let app = axum::Router::new().route(
            "/orders",
            axum::routing::get(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                let orders = orders.clone();
                async move { axum::Json(orders) }
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let ct = CardTraderClient::with_base(format!("http://{address}"));
        let firestore = crate::firebase::MemoryFirestore::new();

        let store = MemoryStore::default();
        *store.listings.lock().unwrap() = vec![
            linked("present", 1, 1, "active"),
            linked("restocked", 2, 1, "active"),     // CardTrader now has 3
            linked("sold-on-ct", 4, 1, "active"),    // gone, sale evidence
            linked("deleted-on-ct", 5, 2, "active"), // gone, no sale
            linked("settled-1", 101, 0, "sold_out"), // settled by earlier runs
            linked("settled-2", 102, 0, "sold_out"),
            linked("settled-3", 103, 0, "sold_out"),
        ];
        *store.links.lock().unwrap() = [("1", false), ("2", false), ("4", false), ("5", false), ("101", true), ("102", true), ("103", true)]
            .into_iter()
            .map(|(id, missing)| (id.to_string(), missing))
            .collect();
        let product = |id: u32, quantity: i64| {
            json!({"id": id, "blueprint_id": 100, "game_id": 5, "quantity": quantity, "price": 2.0,
                   "properties_hash": {"condition": "Near Mint", "pokemon_language": "en"}})
        };
        let export = ProductsExport::from_rows(&[product(1, 1), product(2, 3)]);
        let run = || reconcile_linked_listings(&store, &firestore, &ct, "token", "seller", "Seller", "IT", &export, None, &|_| {});

        let first = run().await.unwrap();
        let summary = &first["summary"];
        assert_eq!(first["complete"], true);
        assert_eq!((summary["removed"].clone(), summary["soldOnCardTrader"].clone(), summary["delisted"].clone()), (json!(2), json!(1), json!(1)));
        assert_eq!((summary["updated"].clone(), summary["alreadyLinked"].clone()), (json!(1), json!(2)));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        assert_eq!((store.listing("sold-on-ct").status.as_str(), store.listing("sold-on-ct").quantity_available), ("sold_out", 0));
        assert_eq!(store.listing("deleted-on-ct").status, "inactive");
        assert_eq!(store.listing("restocked").quantity_available, 3);
        assert!(firestore
            .get_doc(crate::cardtrader::webhook::EVENTS_COLLECTION, &crate::cardtrader::webhook::event_doc_id("seller", "55", "9"))
            .await
            .unwrap()
            .exists);
        let writes = store.take_writes();
        assert!(!writes.iter().any(|w| w.contains("settled-") || w.contains(" 10")), "settled rows untouched: {writes:?}");

        // Next run: what the first one removed is settled, nothing is
        // removed, written or fetched again.
        let second = run().await.unwrap();
        assert_eq!(second["summary"]["removed"], 0);
        assert_eq!(second["summary"]["updated"], 0);
        assert_eq!(second["gateReason"], "complete_ok");
        assert_eq!(fetches.load(Ordering::SeqCst), 1, "no order fetch without new removals");
        assert_eq!(store.take_writes(), Vec::<String>::new());
    }

    #[test]
    fn incremental_evidence_reads_since_the_last_good_sync() {
        let day = 86_400_000i64;
        let now = crate::time_util::ms_from_iso("2026-10-10T08:00:00Z").unwrap();
        assert_eq!(incremental_evidence_from(Some(now - day / 24), now), "2026-10-08");
        assert_eq!(incremental_evidence_from(None, now), "2026-09-10");
        assert_eq!(incremental_evidence_from(Some(now - 90 * day), now), "2026-09-10");
    }

    #[test]
    fn sale_evidence_from_is_a_utc_day_30_days_back() {
        let from = sale_evidence_from(&30);
        assert_eq!(from.len(), 10);
        assert!(from.starts_with("20"));
    }

    #[test]
    fn last_sold_book_prefers_latest_day() {
        let rows = vec![
            json!({"blueprint_id": "9", "sale_day": "2026-09-01", "pkn": 5.0}),
            json!({"blueprint_id": "9", "sale_day": "2026-10-01", "pkn": 7.5}),
        ];
        let book = last_sold_book(&rows);
        assert_eq!(book.get("9").unwrap().1, 7.5);
        assert_eq!(book.get("9").unwrap().0, "2026-10-01");
    }
}
