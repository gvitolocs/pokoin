/**
 * CardTrader seller inventory reconcile (Pokoin-owned).
 *
 * Uses COMPLETE GET /products/export only. Incomplete/failed exports never
 * destroy linked Pokoin stock. Pokoin-only listings (no ct: link) are untouched.
 */

'use strict';

const { fetchProductsExport, validateCardTraderToken } = require('./_cardtrader_client');
const { decryptIntegrationToken, markOneDayReady } = require('./_cardtrader_integration');
const { marketplaceWriteQuery, marketplaceQuery } = require('../server/_marketplace_db');
const {
  CT_PREFIX,
  SOURCE_IMPORT,
  cleanText,
  ctSourceListingId,
  destructiveReconcileGate,
  emptySummary,
  facetKey,
  isCtLinkedSource,
  isPokemonProduct,
  normalizeProduct,
  oneDayReadyAssetRow,
  oneDayReadyTotals,
  parseCtProductId,
  publicCardIdFromBlueprint,
  resolveProductAttachment,
} = require('./_cardtrader_inventory_sync_core');

async function fetchCompleteSellerInventory(token) {
  const products = await fetchProductsExport(token);
  if (!Array.isArray(products)) {
    const error = new Error('CardTrader products/export did not return an array.');
    error.statusCode = 502;
    error.incomplete = true;
    throw error;
  }
  return { complete: true, exportOk: true, products };
}

async function loadSellerListings(sellerUid) {
  const result = await marketplaceQuery(
    `
      select id, card_id, seller_uid, condition, language, price_pkn, quantity_available,
             signed, reverse, first_edition, foil_state, sealed, graded, altered,
             status, source, source_listing_id, card_name, set_name, collector_number,
             seller_comment, shipping_available
      from public.marketplace_user_listings
      where seller_uid = $1
        and status in ('active', 'paused', 'sold_out')
    `,
    [sellerUid],
  );
  return result.rows || [];
}

async function loadProductLinks(sellerUid) {
  try {
    const result = await marketplaceQuery(
      `
        select seller_uid, ct_product_id, listing_id::text, blueprint_id,
               last_ct_quantity, last_seen_at, origin, missing_from_ct
        from public.marketplace_cardtrader_product_links
        where seller_uid = $1
      `,
      [sellerUid],
    );
    return result.rows || [];
  } catch (error) {
    if (/does not exist/i.test(String(error.message || ''))) return [];
    throw error;
  }
}

async function upsertProductLink({
  sellerUid,
  ctProductId,
  listingId,
  blueprintId,
  quantity,
  origin,
  missingFromCt = false,
}) {
  try {
    await marketplaceWriteQuery(
      `
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
      `,
      [sellerUid, ctProductId, listingId, blueprintId || '', quantity, origin, missingFromCt],
    );
  } catch (error) {
    if (/does not exist/i.test(String(error.message || ''))) return null;
    throw error;
  }
}

async function recordSellerSync(sellerUid, {
  ok,
  incomplete,
  error = '',
  summary,
  exportCount = 0,
  complete = false,
}) {
  try {
    await marketplaceWriteQuery(
      `
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
      `,
      [
        sellerUid,
        ok === true,
        incomplete === true,
        cleanText(error, 500),
        JSON.stringify(summary || {}),
        complete === true,
        exportCount,
      ],
    );
  } catch (err) {
    if (/does not exist/i.test(String(err.message || ''))) return null;
    throw err;
  }
}

async function readSellerSync(sellerUid) {
  try {
    const result = await marketplaceQuery(
      `
        select last_sync_at, last_sync_ok, last_sync_incomplete, last_sync_error,
               last_sync_summary, last_complete_export_at, last_export_product_count
        from public.marketplace_cardtrader_seller_sync
        where seller_uid = $1
        limit 1
      `,
      [sellerUid],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (/does not exist/i.test(String(error.message || ''))) return null;
    throw error;
  }
}

async function cardMetadata(cardId) {
  try {
    const result = await marketplaceQuery(
      `
        select
          coalesce(nullif(card_name, ''), '') as card_name,
          coalesce(nullif(set_name, ''), 'Pokemon') as set_name,
          coalesce(nullif(collector_number, ''), '') as collector_number,
          coalesce(nullif(image_url, ''), '') as card_image_url
        from public.marketplace_search_candidates
        where card_id = $1
        limit 1
      `,
      [cardId],
    );
    return result.rows[0] || {};
  } catch (_) {
    return {};
  }
}

async function applyCtQuantity(listingId, quantity) {
  const qty = Math.max(0, Math.min(999999, Math.trunc(Number(quantity) || 0)));
  const result = await marketplaceWriteQuery(
    `
      update public.marketplace_user_listings
      set
        quantity_available = $2,
        status = case
          when $2 <= 0 then 'sold_out'
          when status = 'sold_out' then 'active'
          else status
        end,
        updated_at = now()
      where id = $1
        and source_listing_id like 'ct:%'
      returning id, quantity_available, status, card_id, source_listing_id
    `,
    [listingId, qty],
  );
  return result.rows[0] || null;
}

async function linkExistingListing(listingId, product) {
  const sourceListingId = ctSourceListingId(product.id);
  const qty = Math.max(0, Math.min(999999, product.quantity));
  const values = [listingId, sourceListingId, qty];
  let priceSql = '';
  if (product.pricePkn > 0) {
    values.push(product.pricePkn);
    priceSql = `, price_pkn = $${values.length}`;
  }
  const result = await marketplaceWriteQuery(
    `
      update public.marketplace_user_listings
      set
        source_listing_id = $2,
        quantity_available = $3,
        status = case when $3 <= 0 then 'sold_out' else 'active' end,
        updated_at = now()
        ${priceSql}
      where id = $1
      returning id, source_listing_id, quantity_available, status, card_id
    `,
    values,
  );
  return result.rows[0] || null;
}

async function createImportedListing({ sellerUid, sellerName, product, cardId, reactivateHidden = false }) {
  const meta = await cardMetadata(cardId);
  const qty = Math.max(0, Math.min(999999, product.quantity));
  const pricePkn = product.pricePkn;
  if (!(pricePkn > 0)) {
    const error = new Error('CardTrader product has no usable price.');
    error.code = 'no_price';
    throw error;
  }
  if (qty <= 0) {
    const error = new Error('CardTrader product quantity is zero.');
    error.code = 'zero_qty';
    throw error;
  }
  const sourceListingId = ctSourceListingId(product.id);

  const existing = await marketplaceQuery(
    `
      select id, source_listing_id, quantity_available, status, card_id
      from public.marketplace_user_listings
      where seller_uid = $1 and source_listing_id = $2
      limit 1
    `,
    [sellerUid, sourceListingId],
  );
  const found = existing.rows[0];
  if (found && found.status === 'inactive' && reactivateHidden) {
    // Hidden by a 1-Day Ready sync (no product link left): the account is a
    // listing account again, so the import is public again.
    const reactivated = await marketplaceWriteQuery(
      `
        update public.marketplace_user_listings
        set status = 'active', quantity_available = $2, price_pkn = $3, updated_at = now()
        where id = $1
        returning id, source_listing_id, quantity_available, status, card_id
      `,
      [found.id, qty, pricePkn],
    );
    return reactivated.rows[0] || found;
  }
  if (found) return found;

  const result = await marketplaceWriteQuery(
    `
      insert into public.marketplace_user_listings (
        card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
        condition, language, price_pkn, quantity_available, signed, reverse,
        first_edition, foil_state, variant_state, sealed, graded,
        shipping_available, reserve_available, nft_available, seller_comment,
        source, source_listing_id, status, card_name, card_image_url,
        set_name, collector_number, altered
      )
      values (
        $1,$2,$3,'EU','New',
        $4,$5,$6,$7,$8,$9,
        $10,$11,'',false,$12,
        true,false,false,$13,
        $14,$15,'active',$16,$17,
        $18,$19,$20
      )
      returning id, source_listing_id, quantity_available, status, card_id
    `,
    [
      cardId,
      sellerUid,
      cleanText(sellerName, 120) || 'Pokoin seller',
      product.condition,
      product.language,
      pricePkn,
      qty,
      product.signed === true,
      product.reverse === true,
      product.firstEdition === true,
      product.reverse ? 'reverse' : 'standard',
      product.graded === true,
      product.description || '',
      SOURCE_IMPORT,
      sourceListingId,
      product.name || meta.card_name || cardId,
      meta.card_image_url || '',
      meta.set_name || 'Pokemon',
      meta.collector_number || '',
      product.altered === true,
    ],
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------- 1-Day Ready

async function upsertOneDayReadyAsset(sellerUid, row) {
  await marketplaceWriteQuery(
    `
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
    `,
    [
      sellerUid, row.ctProductId, row.blueprintId, row.cardId, row.cardName, row.setName,
      row.collectorNumber, row.cardImageUrl, row.condition, row.language, row.reverse,
      row.firstEdition, row.signed, row.altered, row.graded, row.quantity, row.pricePkn,
    ],
  );
}

async function removeMissingOneDayReadyAssets(sellerUid, keepProductIds) {
  const result = await marketplaceWriteQuery(
    `
      delete from public.marketplace_cardtrader_1dr_assets
      where seller_uid = $1
        and not (ct_product_id = any($2::text[]))
    `,
    [sellerUid, keepProductIds],
  );
  return result.rowCount || 0;
}

/**
 * 1-Day Ready stock is never a Pokoin listing: hide the public copies an
 * earlier listing-mode sync imported, and drop their product links so order
 * webhooks leave them alone. Pokoin-only and pushed listings are untouched.
 */
async function hideImportedCardTraderListings(sellerUid) {
  const hidden = await marketplaceWriteQuery(
    `
      update public.marketplace_user_listings
      set status = 'inactive', updated_at = now()
      where seller_uid = $1
        and source = $2
        and source_listing_id like 'ct:%'
        and status <> 'inactive'
      returning id, card_id
    `,
    [sellerUid, SOURCE_IMPORT],
  );
  const rows = hidden.rows || [];
  await marketplaceWriteQuery(
    `
      delete from public.marketplace_cardtrader_product_links
      where seller_uid = $1 and origin = 'import'
    `,
    [sellerUid],
  );
  // Card pages' "from N PKN" summaries must stop counting the hidden rows.
  for (const cardId of new Set(rows.map((row) => cleanText(row.card_id, 80)).filter(Boolean))) {
    try {
      await marketplaceWriteQuery('select public.refresh_marketplace_blueprint_price_summary($1)', [cardId]);
    } catch (error) {
      console.error('cardtrader 1dr price summary refresh failed', { cardId, message: error.message });
    }
  }
  return rows.length;
}

async function reconcileOneDayReadyAssets({ sellerUid, products, gate, summary }) {
  Object.assign(summary, {
    mode: 'one_day_ready',
    assets: 0,
    assetCards: 0,
    assetValuePkn: 0,
    hiddenListings: 0,
  });
  const rows = [];
  for (const product of products) {
    if (!isPokemonProduct(product)) {
      summary.skippedNonPokemon += 1;
      continue;
    }
    summary.pokemonInventory += 1;
    const cardId = publicCardIdFromBlueprint(product.blueprintId) || '';
    try {
      const meta = cardId ? await cardMetadata(cardId) : {};
      const row = oneDayReadyAssetRow(product, { cardId, meta });
      await upsertOneDayReadyAsset(sellerUid, row);
      rows.push(row);
    } catch (error) {
      summary.errors += 1;
      summary.errorItems.push({ ctProductId: product.id, reason: error.code || error.message || 'asset_error' });
    }
  }
  // Only a complete, error-free pass may delete assets CardTrader no longer has.
  if (gate.allowDestructive && summary.errors === 0) {
    summary.removed = await removeMissingOneDayReadyAssets(sellerUid, rows.map((row) => row.ctProductId));
  }
  summary.hiddenListings = await hideImportedCardTraderListings(sellerUid);
  const totals = oneDayReadyTotals(rows);
  summary.assets = totals.products;
  summary.assetCards = totals.cards;
  summary.assetValuePkn = totals.valuePkn;

  const persisted = {
    ...summary,
    unresolvedItems: summary.unresolvedItems.slice(0, 25),
    errorItems: summary.errorItems.slice(0, 25),
  };
  await recordSellerSync(sellerUid, {
    ok: summary.errors === 0,
    incomplete: !gate.allowDestructive,
    error: gate.allowDestructive ? '' : gate.reason,
    summary: persisted,
    exportCount: summary.inventory,
    complete: gate.allowDestructive,
  });
  return {
    ok: true,
    oneDayReady: true,
    incomplete: !gate.allowDestructive,
    connected: true,
    complete: gate.allowDestructive,
    destructiveSkipped: !gate.allowDestructive,
    summary: persisted,
  };
}

async function readOneDayReadyAssets(sellerUid, { limit = 500 } = {}) {
  const result = await marketplaceQuery(
    `
      select ct_product_id, blueprint_id, card_id, card_name, set_name,
             collector_number, card_image_url, condition, language, reverse,
             first_edition, signed, altered, graded, quantity, price_pkn, updated_at
      from public.marketplace_cardtrader_1dr_assets
      where seller_uid = $1 and quantity > 0
      order by price_pkn * quantity desc, card_name asc
      limit $2
    `,
    [sellerUid, Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 500)))],
  );
  return result.rows || [];
}

async function reconcileCardTraderInventory({
  firestore,
  uid,
  sellerName = '',
  token: providedToken = null,
  oneDayReady: providedOneDayReady,
} = {}) {
  const summary = emptySummary();
  const sellerUid = cleanText(uid, 160);
  if (!sellerUid) {
    const error = new Error('Missing seller uid.');
    error.statusCode = 400;
    throw error;
  }

  let token = providedToken;
  try {
    if (!token) token = await decryptIntegrationToken(firestore, sellerUid);
  } catch (error) {
    await recordSellerSync(sellerUid, {
      ok: false,
      incomplete: true,
      error: error.message || 'Not connected.',
      summary,
      complete: false,
    });
    return {
      ok: false,
      incomplete: true,
      connected: false,
      destructiveSkipped: true,
      error: error.message || 'CardTrader is not connected.',
      summary,
    };
  }

  // Account type decides where the stock goes: 1-Day Ready → dashboard assets.
  let oneDayReady = typeof providedOneDayReady === 'boolean' ? providedOneDayReady : null;
  if (oneDayReady === null) {
    try {
      oneDayReady = (await validateCardTraderToken(token)).oneDayReady === true;
      await markOneDayReady(firestore, sellerUid, oneDayReady);
    } catch (error) {
      // Unknown account type: never publish stock that may be CardTrader's own.
      await recordSellerSync(sellerUid, {
        ok: false,
        incomplete: true,
        error: error.message || 'CardTrader account check failed.',
        summary,
        complete: false,
      });
      return {
        ok: false,
        incomplete: true,
        connected: true,
        destructiveSkipped: true,
        error: error.message || 'CardTrader account check failed.',
        summary,
      };
    }
  }

  let exportResult;
  try {
    exportResult = await fetchCompleteSellerInventory(token);
  } catch (error) {
    summary.errors += 1;
    summary.errorItems.push({ reason: error.message || 'export_failed' });
    await recordSellerSync(sellerUid, {
      ok: false,
      incomplete: true,
      error: error.message || 'CardTrader export failed.',
      summary,
      complete: false,
    });
    return {
      ok: false,
      incomplete: true,
      connected: true,
      destructiveSkipped: true,
      error: error.message || 'CardTrader inventory export failed.',
      summary,
    };
  }

  const gate = destructiveReconcileGate(exportResult);
  const products = (exportResult.products || []).map(normalizeProduct).filter((p) => p.id);
  summary.inventory = products.length;

  if (oneDayReady) {
    return reconcileOneDayReadyAssets({ sellerUid, products, gate, summary });
  }

  const listings = await loadSellerListings(sellerUid);
  const links = await loadProductLinks(sellerUid);

  const bySourceId = new Map();
  const byListingId = new Map();
  const unlinkedByFacet = new Map();
  for (const row of listings) {
    byListingId.set(String(row.id), row);
    const sourceId = cleanText(row.source_listing_id, 160);
    if (isCtLinkedSource(sourceId)) {
      bySourceId.set(sourceId, row);
    } else if (row.status === 'active' || row.status === 'paused') {
      const key = facetKey(row);
      const bucket = unlinkedByFacet.get(key) || [];
      bucket.push(row);
      unlinkedByFacet.set(key, bucket);
    }
  }

  const linkByProduct = new Map(links.map((l) => [cleanText(l.ct_product_id, 80), l]));
  const seenProductIds = new Set();

  for (const product of products) {
    if (!isPokemonProduct(product)) {
      summary.skippedNonPokemon += 1;
      continue;
    }
    summary.pokemonInventory += 1;
    seenProductIds.add(product.id);

    // Prefer link table → source id for already-linked via push that may not be in bySourceId maps yet
    if (!bySourceId.has(ctSourceListingId(product.id))) {
      const link = linkByProduct.get(product.id);
      if (link?.listing_id && byListingId.has(String(link.listing_id))) {
        const linked = byListingId.get(String(link.listing_id));
        if (isCtLinkedSource(linked.source_listing_id)
          || cleanText(linked.source_listing_id, 160) === '') {
          bySourceId.set(ctSourceListingId(product.id), linked);
        }
      }
    }

    const decision = resolveProductAttachment(product, {
      bySourceId,
      byListingId,
      unlinkedByFacet,
    });

    try {
      if (decision.action === 'unresolved') {
        summary.unresolved += 1;
        summary.unresolvedItems.push({
          ctProductId: product.id,
          blueprintId: product.blueprintId,
          reason: decision.reason,
          name: decision.name || product.name,
          candidates: decision.candidates,
        });
        continue;
      }

      if (decision.action === 'already_linked') {
        summary.alreadyLinked += 1;
        const listing = decision.listing;
        const currentQty = Number(listing.quantity_available) || 0;
        if (currentQty !== product.quantity
          || (product.quantity > 0 && listing.status === 'sold_out')) {
          await applyCtQuantity(listing.id, product.quantity);
          summary.updated += 1;
        }
        await upsertProductLink({
          sellerUid,
          ctProductId: product.id,
          listingId: listing.id,
          blueprintId: product.blueprintId,
          quantity: product.quantity,
          origin: linkByProduct.get(product.id)?.origin || 'push',
          missingFromCt: false,
        });
        continue;
      }

      if (decision.action === 'link_existing') {
        if (decision.facetKey) unlinkedByFacet.set(decision.facetKey, []);
        const updated = await linkExistingListing(decision.listing.id, product);
        if (!updated) {
          summary.errors += 1;
          summary.errorItems.push({ ctProductId: product.id, reason: 'link_failed' });
          continue;
        }
        summary.matchedExisting += 1;
        bySourceId.set(decision.sourceId, { ...decision.listing, ...updated });
        await upsertProductLink({
          sellerUid,
          ctProductId: product.id,
          listingId: updated.id,
          blueprintId: product.blueprintId,
          quantity: product.quantity,
          origin: decision.origin || 'match',
          missingFromCt: false,
        });
        continue;
      }

      if (decision.action === 'import') {
        const created = await createImportedListing({
          sellerUid,
          sellerName,
          product,
          cardId: decision.cardId || publicCardIdFromBlueprint(product.blueprintId),
          reactivateHidden: !linkByProduct.has(product.id),
        });
        if (!created) {
          summary.errors += 1;
          summary.errorItems.push({ ctProductId: product.id, reason: 'import_failed' });
          continue;
        }
        summary.imported += 1;
        bySourceId.set(decision.sourceId, created);
        byListingId.set(String(created.id), created);
        await upsertProductLink({
          sellerUid,
          ctProductId: product.id,
          listingId: created.id,
          blueprintId: product.blueprintId,
          quantity: product.quantity,
          origin: 'import',
          missingFromCt: false,
        });
      }
    } catch (error) {
      summary.errors += 1;
      summary.errorItems.push({
        ctProductId: product.id,
        reason: error.code || error.message || 'sync_error',
      });
    }
  }

  if (gate.allowDestructive) {
    for (const [sourceId, listing] of bySourceId.entries()) {
      const productId = parseCtProductId(sourceId);
      if (!productId || seenProductIds.has(productId)) continue;
      if (!isCtLinkedSource(listing.source_listing_id)) continue;
      if (listing.status === 'sold_out' && Number(listing.quantity_available) === 0) {
        await upsertProductLink({
          sellerUid,
          ctProductId: productId,
          listingId: listing.id,
          blueprintId: '',
          quantity: 0,
          origin: linkByProduct.get(productId)?.origin || 'import',
          missingFromCt: true,
        });
        continue;
      }
      const updated = await applyCtQuantity(listing.id, 0);
      if (updated) summary.removed += 1;
      await upsertProductLink({
        sellerUid,
        ctProductId: productId,
        listingId: listing.id,
        blueprintId: '',
        quantity: 0,
        origin: linkByProduct.get(productId)?.origin || 'import',
        missingFromCt: true,
      });
    }
  }

  const persisted = {
    ...summary,
    unresolvedItems: summary.unresolvedItems.slice(0, 25),
    errorItems: summary.errorItems.slice(0, 25),
  };

  await recordSellerSync(sellerUid, {
    ok: summary.errors === 0,
    incomplete: !gate.allowDestructive,
    error: gate.allowDestructive ? '' : gate.reason,
    summary: persisted,
    exportCount: summary.inventory,
    complete: gate.allowDestructive,
  });

  return {
    ok: true,
    incomplete: !gate.allowDestructive,
    connected: true,
    complete: gate.allowDestructive,
    destructiveSkipped: !gate.allowDestructive,
    summary: persisted,
  };
}

module.exports = {
  applyCtQuantity,
  fetchCompleteSellerInventory,
  readOneDayReadyAssets,
  readSellerSync,
  reconcileCardTraderInventory,
  recordSellerSync,
};
