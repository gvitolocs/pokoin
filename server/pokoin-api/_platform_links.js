'use strict';

function getWriteQuery(query) {
  if (query) return query;
  return require('./_marketplace_db').marketplaceWriteQuery;
}

async function upsertLink({ listingId, sellerUid, provider, externalId, externalMeta = {}, matchMethod }, query) {
  const writeQuery = getWriteQuery(query);
  const result = await writeQuery(
    `
      insert into public.marketplace_platform_links (
        listing_id, seller_uid, provider, external_id, external_meta, match_method,
        created_at, updated_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6, now(), now())
      on conflict (listing_id, provider) do update set
        seller_uid = excluded.seller_uid,
        external_id = excluded.external_id,
        external_meta = excluded.external_meta,
        match_method = excluded.match_method,
        updated_at = now()
      returning listing_id, seller_uid, provider, external_id, external_meta, match_method,
        last_pushed_at, last_error, created_at, updated_at
    `,
    [listingId, sellerUid, provider, externalId, JSON.stringify(externalMeta), matchMethod]
  );
  return result.rows[0] || null;
}

async function findLinkByExternal({ sellerUid, provider, externalId }, query) {
  // Writer, not the read replica: a link created seconds ago must be visible.
  const writeQuery = getWriteQuery(query);
  const result = await writeQuery(
    `
      select l.listing_id, l.seller_uid, l.provider, l.external_id, l.external_meta,
        l.match_method, l.last_pushed_at, l.last_error, l.created_at, l.updated_at,
        u.card_id, u.source_listing_id, u.quantity_available, u.status
      from public.marketplace_platform_links l
      join public.marketplace_user_listings u on u.id = l.listing_id
      where l.seller_uid = $1
        and l.provider = $2
        and l.external_id = $3
      limit 1
    `,
    [sellerUid, provider, externalId]
  );
  return result.rows[0] || null;
}

async function linksForListing(listingId, query) {
  // Writer, not the read replica: the fan-out must see a just-created link.
  const writeQuery = getWriteQuery(query);
  const result = await writeQuery(
    `
      select listing_id, seller_uid, provider, external_id, external_meta,
        match_method, last_pushed_at, last_error, created_at, updated_at
      from public.marketplace_platform_links
      where listing_id = $1
    `,
    [listingId]
  );
  return result.rows;
}

async function deleteLinksForProvider({ sellerUid, provider }, query) {
  const writeQuery = getWriteQuery(query);
  const result = await writeQuery(
    `
      delete from public.marketplace_platform_links
      where seller_uid = $1 and provider = $2
    `,
    [sellerUid, provider]
  );
  return result.rowCount || 0;
}

async function deleteLink({ listingId, provider, sellerUid }, query) {
  const writeQuery = getWriteQuery(query);
  const result = await writeQuery(
    `
      delete from public.marketplace_platform_links
      where listing_id = $1 and provider = $2 and seller_uid = $3
    `,
    [listingId, provider, sellerUid]
  );
  return result.rowCount || 0;
}

async function markPushed({ listingId, provider, error = '' }, query) {
  const writeQuery = getWriteQuery(query);
  await writeQuery(
    `
      update public.marketplace_platform_links
      set last_pushed_at = now(), last_error = $3, updated_at = now()
      where listing_id = $1 and provider = $2
    `,
    [listingId, provider, error.slice(0, 500)]
  );
}

async function claimEvent({ client, query, sellerUid, provider, orderId, itemId, kind, listingId, quantity }, queryArg) {
  const writeQuery = getWriteQuery(query || client || queryArg);
  const useClient = client || null;
  const exec = useClient ? (sql, params) => useClient.query(sql, params) : writeQuery;
  const result = await exec(
    `
      insert into public.marketplace_platform_sync_events (
        seller_uid, provider, external_order_id, external_item_id, kind,
        listing_id, quantity
      ) values ($1, $2, $3, $4, $5, $6::uuid, $7)
      on conflict (seller_uid, provider, external_order_id, external_item_id, kind) do nothing
      returning 1
    `,
    [sellerUid, provider, orderId, itemId, kind, listingId, quantity]
  );
  return result.rowCount > 0 || result.rows.length > 0;
}

async function releaseEvent({ client, query, sellerUid, provider, orderId, itemId, kind }, queryArg) {
  const writeQuery = getWriteQuery(query || client || queryArg);
  const useClient = client || null;
  const exec = useClient ? (sql, params) => useClient.query(sql, params) : writeQuery;
  await exec(
    `
      delete from public.marketplace_platform_sync_events
      where seller_uid = $1 and provider = $2 and external_order_id = $3 and external_item_id = $4 and kind = $5
    `,
    [sellerUid, provider, orderId, itemId, kind]
  );
}

async function findEvent({ sellerUid, provider, orderId, itemId, kind }, query) {
  // Writer: the sale claim must be visible on the same pool that wrote it.
  const writeQuery = getWriteQuery(query);
  const result = await writeQuery(
    `
      select seller_uid, provider, external_order_id, external_item_id, kind,
        listing_id, quantity, created_at
      from public.marketplace_platform_sync_events
      where seller_uid = $1 and provider = $2 and external_order_id = $3 and external_item_id = $4 and kind = $5
      limit 1
    `,
    [sellerUid, provider, orderId, itemId, kind]
  );
  return result.rows[0] || null;
}

module.exports = {
  upsertLink,
  findLinkByExternal,
  linksForListing,
  deleteLinksForProvider,
  deleteLink,
  markPushed,
  claimEvent,
  releaseEvent,
  findEvent,
};