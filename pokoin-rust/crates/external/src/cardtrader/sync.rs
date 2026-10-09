//! CardTrader seller inventory reconcile — native port of
//! `_cardtrader_inventory_sync.js`. COMPLETE exports only; the destructive
//! gate, vanished-product sale evidence, checkout holds, and the
//! one-day-ready asset mode are preserved exactly.

use serde_json::{json, Value};

use crate::cardtrader::client::CardTraderClient;
use crate::cardtrader::integration as ct_integration;
use crate::cardtrader::sync_core::*;
use crate::db::DbPools;
use crate::error::{clean_text, clean_text_value, i64_field, ApiError, ApiResult, ValueExt};
use crate::firebase::FirestoreStore;

const LOAD_SELLER_LISTINGS_SQL: &str = r#"
      select id, card_id, seller_uid, condition, language, price_pkn, quantity_available,
             signed, reverse, first_edition, foil_state, sealed, graded, altered,
             status, source, source_listing_id, card_name, set_name, collector_number,
             seller_comment, shipping_available, created_at
      from public.marketplace_user_listings
      where seller_uid = $1
        and status in ('active', 'paused', 'sold_out')
"#;

const LOAD_PRODUCT_LINKS_SQL: &str = r#"
        select seller_uid, ct_product_id, listing_id::text, blueprint_id,
               last_ct_quantity, last_seen_at, origin, missing_from_ct
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

pub async fn load_seller_listings(db: &DbPools, seller_uid: &str) -> ApiResult<Vec<Value>> {
    Ok(db.query("pokemon", LOAD_SELLER_LISTINGS_SQL, &[json!(seller_uid)]).await?)
}

pub async fn load_product_links(db: &DbPools, seller_uid: &str) -> ApiResult<Vec<Value>> {
    match db.query("pokemon", LOAD_PRODUCT_LINKS_SQL, &[json!(seller_uid)]).await {
        Ok(rows) => Ok(rows),
        Err(error) if error.is_table_missing() => Ok(Vec::new()),
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
    let qty = quantity.clamp(0, 999_999);
    let rows = db
        .write("pokemon", APPLY_CT_QUANTITY_SQL, &[json!(listing_id), json!(qty)])
        .await?;
    Ok(rows.first().cloned())
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

    let existing = db
        .query("pokemon", FIND_EXISTING_BY_SOURCE_SQL, &[json!(seller_uid), json!(source_listing_id)])
        .await?;
    if let Some(found) = existing.first().cloned() {
        let found_status = clean_text_value(found.get("status").unwrap_or(&Value::Null), 40);
        if found_status == "inactive" && reactivate_hidden {
            let rows = db
                .write(
                    "pokemon",
                    REACTIVATE_HIDDEN_SQL,
                    &[found["id"].clone(), json!(qty), json!(price_pkn), json!(stock_location)],
                )
                .await?;
            return Ok(rows.first().cloned().or(Some(found)));
        }
        let found_location = clean_text_value(found.get("location").unwrap_or(&Value::Null), 120);
        if !stock_location.is_empty() && found_location.is_empty() {
            let rows = db
                .write("pokemon", PATCH_LOCATION_IF_EMPTY_SQL, &[found["id"].clone(), json!(stock_location)])
                .await?;
            return Ok(rows.first().cloned().or(Some(found)));
        }
        return Ok(Some(found));
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
    let rows = db
        .write(
            game,
            CREATE_IMPORTED_LISTING_SQL,
            &[
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
            ],
        )
        .await?;
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

    let export = match ct.fetch_products_export(&token).await {
        Ok(products) => products,
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

    let (allow_destructive, gate_reason) = destructive_reconcile_gate(true, true, true);
    let products: Vec<NormalizedProduct> = export
        .iter()
        .map(normalize_product)
        .filter(|p| !p.id.is_empty())
        .collect();
    summary["inventory"].set_i64(products.len() as i64);

    if preview_games_only {
        let mut games: serde_json::Map<String, Value> = serde_json::Map::new();
        for product in &products {
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
        return reconcile_one_day_ready_assets(db, firestore, ct, &seller_uid, &products, allow_destructive, gate_reason, &mut summary, &emit, &token).await;
    }

    let listings = load_seller_listings(db, &seller_uid).await?;
    let links = load_product_links(db, &seller_uid).await?;

    let plan = plan_inventory_reconcile(&export, &listings, true, true);
    // Reuse the planned summary counts as the running summary.
    summary = plan.summary.clone();

    let mut link_by_product: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for link in &links {
        link_by_product.insert(clean_text_value(link.get("ct_product_id").unwrap_or(&Value::Null), 80), link.clone());
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
    let meta_by_card = card_metadata_many(db, &import_card_ids, "pokemon").await;

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
                PlannedAction::UpdateQty { product_id, listing_id, quantity } => {
                    summary["alreadyLinked"].incr(1);
                    apply_ct_quantity(db, listing_id, *quantity).await?;
                    summary["updated"].incr(1);
                    let _ = product_id;
                    Ok(())
                }
                PlannedAction::Link { product_id, listing_id } => {
                    if let Some(product) = products.iter().find(|p| p.id == *product_id) {
                        let updated = link_existing_listing(db, listing_id, product).await?;
                        if updated.is_none() {
                            summary["errors"].incr(1);
                            summary["errorItems"].as_array_mut().unwrap().push(json!({ "ctProductId": product_id, "reason": "link_failed" }));
                            return Ok(());
                        }
                        summary["matchedExisting"].incr(1);
                        upsert_product_link(db, &seller_uid, product_id, listing_id, &product.blueprint_id, product.quantity, "match", false).await?;
                    }
                    Ok(())
                }
                PlannedAction::Import { product_id, card_id, .. } => {
                    if let Some(product) = products.iter().find(|p| p.id == *product_id) {
                        let existing_link = link_by_product.get(product_id);
                        let reactivate = existing_link.is_none()
                            || existing_link.map(|l| l.get("missing_from_ct").map(|v| v == &json!(true)).unwrap_or(false)).unwrap_or(false);
                        let meta = meta_by_card.get(card_id).cloned().unwrap_or(json!({}));
                        let created = create_imported_listing(
                            db,
                            &seller_uid,
                            &seller_name,
                            &seller_country,
                            product,
                            card_id,
                            marketplace_game_for_product(product),
                            reactivate,
                            &meta,
                            "",
                        )
                        .await?;
                        let Some(created) = created else {
                            summary["errors"].incr(1);
                            summary["errorItems"].as_array_mut().unwrap().push(json!({ "ctProductId": product_id, "reason": "import_failed" }));
                            return Ok(());
                        };
                        upsert_product_link(
                            db,
                            &seller_uid,
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
        let listing_rows: Vec<ListingRow> = listings.iter().map(listing_row).collect();
        let mut vanished: Vec<(String, ListingRow)> = Vec::new();
        for action in &plan.actions {
            if let PlannedAction::Remove { product_id, listing_id, source_id } = action {
                if listing_id.starts_with("import:") {
                    continue;
                }
                let row = listing_rows
                    .iter()
                    .find(|row| row.id == *listing_id && row.source_listing_id == *source_id)
                    .cloned()
                    .unwrap_or(ListingRow {
                        id: listing_id.clone(),
                        card_id: String::new(),
                        quantity_available: 0,
                        status: String::new(),
                        source_listing_id: source_id.clone(),
                    });
                vanished.push((product_id.clone(), row));
            }
        }

        // Sale evidence comes from CardTrader's own seller orders, never from
        // "it vanished from the export". No data ⇒ Unknown: take it down,
        // claim nothing.
        let mut sales: Option<std::collections::HashMap<String, Vec<(Value, Value)>>> = None;
        if !vanished.is_empty() {
            if let Ok(orders) = ct
                .fetch_seller_orders(&token, &sale_evidence_from(&SALE_EVIDENCE_DAYS), "", 100, 50)
                .await
            {
                sales = Some(sale_items_by_product(&orders));
            }
        }
        for (product_id, listing) in vanished {
            let created_ms = listing_created_ms(&listings, &listing.id);
            let verdict = classify_vanished_product(&product_id, created_ms, sales.as_ref());
            match verdict {
                VanishedVerdict::Sold { sales: matched } => {
                    let _ = apply_ct_quantity(db, &listing.id, 0).await?;
                    ensure_counter(&mut summary, "soldOnCardTrader", 1);
                    // Record missed sales once each (Firestore create = claim).
                    for (order, item) in matched {
                        let id = crate::cardtrader::webhook::event_doc_id(
                            &seller_uid,
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
                                    &seller_uid,
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
                    let _ = delist_ct_listing(db, &listing.id).await?;
                    ensure_counter(&mut summary, "delisted", 1);
                }
            }
            summary["removed"].incr(1);
            upsert_product_link(db, &seller_uid, &product_id, &listing.id, "", 0, "import", true).await?;
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

    record_seller_sync(db, &seller_uid, persisted["errors"].as_i64().unwrap_or(0) == 0, !allow_destructive, if allow_destructive { "" } else { gate_reason }, &persisted, summary["inventory"].as_i64().unwrap_or(0), allow_destructive).await?;

    Ok(json!({
        "ok": true,
        "incomplete": !allow_destructive,
        "connected": true,
        "complete": allow_destructive,
        "destructiveSkipped": !allow_destructive,
        "summary": persisted,
    }))
}

fn ensure_counter(summary: &mut Value, key: &str, delta: i64) {
    let current = summary.get(key).and_then(Value::as_i64).unwrap_or(0);
    summary[key] = json!(current + delta);
}

/// created_at of a listing row as unix ms (sale-evidence lower bound).
fn listing_created_ms(listings: &[Value], listing_id: &str) -> Option<i64> {
    let row = listings.iter().find(|row| {
        clean_text_value(row.get("id").unwrap_or(&Value::Null), 80) == listing_id
    })?;
    row.get("created_at")
        .and_then(Value::as_str)
        .and_then(crate::time_util::ms_from_iso)
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

    // 1dr sales from the evidence window, once each.
    let mut one_day_ready_sales = 0i64;
    if let Ok(orders) = ct
        .fetch_seller_orders(token, &sale_evidence_from(&SALE_EVIDENCE_DAYS), "", 100, 50)
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
