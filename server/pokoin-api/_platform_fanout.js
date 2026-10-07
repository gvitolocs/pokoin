'use strict';

/**
 * Platform sync fan-out.
 *
 * One stock change on Pokoin follows every platform the seller linked, and a
 * sale on any other platform takes the same quantity off Pokoin and off every
 * other link. CardTrader keeps its own webhook/reconcile path (`cardtrader` is
 * never a fan-out target unless a sale originated elsewhere); every other
 * provider goes through its adapter.
 *
 * Invariants enforced here (docs/PLATFORM_SYNC.md):
 *   1. Relative deltas only — adapters receive `delta`, never an absolute qty.
 *   2. Exactly once per external order item: the event claim happens before any
 *      stock moves, and a failed decrement deletes the claim so a retry works.
 *   3. No echo loops: the originating provider is skipped.
 *   4. A failed or incomplete poll never removes stock: only complete reads with
 *      individual sold order items are applied, and unmatched items are reported
 *      rather than guessed.
 *   5. External sales are not Pokoin-native sales: the guarded decrement runs
 *      with `set_config('pokoin.platform_sync', <provider>, true)` in the same
 *      statement, so the listing audit trigger records `platform_synced`.
 *
 * Every external dependency is injectable (`deps`) so the module can be unit
 * tested without Postgres, Firestore, Redis or the network.
 */

const SALES_COLLECTION = 'marketplace_sales';

// The Pokoin decrement. `settings` is referenced by the UPDATE so Postgres
// evaluates the transaction-local set_config before the row trigger fires.
const DECREMENT_LISTING_SQL = `
  with settings as (
    select set_config('pokoin.platform_sync', $1::text, true)
  )
  update public.marketplace_user_listings u
  set
    quantity_available = u.quantity_available - $3,
    status = case when u.quantity_available - $3 <= 0 then 'sold_out' else u.status end,
    updated_at = now()
  from settings
  where u.id = $2::uuid
    and u.seller_uid = $4
    and lower(u.status) in ('active', 'paused')
    and u.quantity_available >= $3
  returning u.id, u.card_id, u.quantity_available, u.status,
    u.source_listing_id, u.price_pkn, u.seller_uid
`;

// Cancel/refund restore. Same guard so the audit trigger stays quiet.
const RESTORE_LISTING_SQL = `
  with settings as (
    select set_config('pokoin.platform_sync', $1::text, true)
  )
  update public.marketplace_user_listings u
  set
    quantity_available = u.quantity_available + $3,
    status = case when lower(u.status) = 'sold_out' then 'active' else u.status end,
    updated_at = now()
  from settings
  where u.id = $2::uuid
    and u.seller_uid = $4
  returning u.id, u.card_id, u.quantity_available, u.status,
    u.source_listing_id, u.price_pkn, u.seller_uid
`;

// CardTrader links live on the listing itself (`source_listing_id` = `ct:<id>`),
// not in marketplace_platform_links, so the fan-out resolves them separately.
const LISTING_SOURCE_SQL = `
  select source_listing_id
  from public.marketplace_user_listings
  where id = $1::uuid
`;

function cleanText(value, maxLength = 240) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function signedInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Math.trunc(number) || 0;
}

function isCardTraderSource(sourceListingId) {
  return /^(ct|cardtrader):/i.test(cleanText(sourceListingId, 160));
}

function saleDocId(provider, orderId, itemId) {
  return `${cleanText(provider, 40)}_${cleanText(orderId, 160)}__${cleanText(itemId, 160)}`
    .replace(/\//g, '_');
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000).toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Normalize one provider sold item (adapter/webhook shape). */
function normalizeSoldItem(raw = {}) {
  return {
    orderId: cleanText(raw.orderId, 160),
    itemId: cleanText(raw.itemId, 160),
    externalId: cleanText(raw.externalId, 160),
    sku: cleanText(raw.sku, 160),
    listingId: cleanText(raw.listingId, 160),
    quantity: positiveInt(raw.quantity),
    unitPriceCents: Math.round(Number(raw.unitPriceCents) || 0),
    currency: cleanText(raw.currency, 8),
    soldAt: raw.soldAt || null,
  };
}

/** Resolve only what a call actually needs; tests inject the rest. */
function resolveDeps(overrides = {}) {
  const deps = { ...overrides };
  if (!deps.links) deps.links = require('./_platform_links');
  if (!deps.integrations) deps.integrations = require('./_platform_integration');
  if (!deps.getAdapter) {
    deps.getAdapter = (provider) => require('./_platform_adapters').getAdapter(provider);
  }
  return deps;
}

function writeExecutor(deps, client) {
  if (client && typeof client.query === 'function') {
    return (sql, params) => client.query(sql, params);
  }
  if (typeof deps.writeQuery === 'function') return (sql, params) => deps.writeQuery(sql, params);
  return (sql, params) => require('./_marketplace_db').marketplaceWriteQuery(sql, params);
}

/**
 * Run `fn(client)` in one writer transaction. The claim and the stock write
 * MUST share one transaction: a crash between them would otherwise either lose
 * a sale (claim kept, decrement rolled back) or double-apply it.
 *
 * `_outbox.withWriterTransaction` returns null when there is no writer pool
 * (local/dev, or the module is absent), so fall back to a single connection.
 */
async function inTransaction(deps, fn) {
  if (typeof deps.withTransaction === 'function') return deps.withTransaction(fn);
  const { withWriterTransaction } = require('./_outbox');
  const result = await withWriterTransaction(fn);
  if (result === null) return fn(null);
  return result;
}

/** Adapter context: decrypted credentials + non-secret metadata. */
async function adapterContext({ deps, firestore, provider, sellerUid, cache }) {
  if (cache.has(provider)) return cache.get(provider);
  let credentials = {};
  if (deps.integrations && typeof deps.integrations.decryptSecrets === 'function') {
    credentials = await deps.integrations.decryptSecrets(firestore, sellerUid, provider);
  }
  let metadata = {};
  try {
    const doc = await deps.integrations.readIntegration(firestore, sellerUid, provider);
    metadata = (doc && doc.exists ? doc.data()?.metadata : null) || {};
  } catch (_) {
    metadata = {};
  }
  const context = { credentials, metadata, fetchFn: deps.fetchFn || fetch };
  cache.set(provider, context);
  return context;
}

async function adjustCardTraderLink({ deps, firestore, sellerUid, sourceListingId, delta }) {
  if (typeof deps.adjustCardTrader === 'function') {
    return deps.adjustCardTrader({ firestore, uid: sellerUid, sourceListingId, delta });
  }
  const listings = require('./_cardtrader_seller_listings');
  if (delta < 0) {
    return listings.decrementLinkedCardTraderProduct({
      firestore,
      uid: sellerUid,
      sourceListingId,
      quantity: Math.abs(delta),
    });
  }
  const productId = listings.parseCtProductId(sourceListingId);
  if (!productId) return { skipped: true, reason: 'not_linked' };
  const { incrementProduct } = require('./_cardtrader_client');
  const { decryptIntegrationToken } = require('./_cardtrader_integration');
  const token = await decryptIntegrationToken(firestore, sellerUid);
  const payload = await incrementProduct(token, productId, Math.abs(delta));
  const resource = payload?.resource || payload?.product || payload || {};
  const left = Number(resource.quantity);
  return {
    ok: true,
    productId,
    restored: Math.abs(delta),
    remaining: Number.isFinite(left) ? left : null,
  };
}

/**
 * Push one relative stock delta to every link except the origin.
 *
 * CardTrader is not a `marketplace_platform_links` row: a CardTrader-linked
 * listing is one whose `source_listing_id` starts with `ct:`. That link is
 * therefore resolved separately (the `sourceListingId` param, else the listing
 * row through the writer) when `includeCardTrader` is set and the origin is not
 * CardTrader itself.
 */
async function fanOutStockChange({
  origin,
  sellerUid,
  listingId,
  sourceListingId = '',
  delta,
  reason = 'stock_change',
  includeCardTrader = false,
  firestore,
  deps: overrides = {},
} = {}) {
  const deps = resolveDeps(overrides);
  const amount = signedInt(delta);
  const originId = cleanText(origin, 40);
  if (!listingId || amount === 0) {
    return { ok: true, skipped: true, reason: 'no_change', items: [] };
  }
  const links = (await deps.links.linksForListing(listingId, writeExecutor(deps, null))) || [];
  const contexts = new Map();
  const items = [];
  let sawCardTraderLink = false;
  for (const link of links) {
    const provider = cleanText(link.provider, 40);
    if (provider === 'cardtrader') sawCardTraderLink = true;
    if (!provider || provider === originId) {
      items.push({ provider, skipped: true, reason: 'origin' });
      continue;
    }
    if (provider === 'cardtrader' && !includeCardTrader) {
      items.push({ provider, skipped: true, reason: 'cardtrader_path' });
      continue;
    }
    try {
      if (provider === 'cardtrader') {
        const source = cleanText(link.source_listing_id, 160);
        if (!isCardTraderSource(source)) {
          items.push({ provider, skipped: true, reason: 'not_linked' });
          continue;
        }
        const result = await adjustCardTraderLink({
          deps,
          firestore,
          sellerUid,
          sourceListingId: source,
          delta: amount,
        });
        items.push({ provider, delta: amount, ...(result || { ok: true }) });
        await deps.links.markPushed({
          listingId,
          provider,
          error: result && result.ok === false ? String(result.error || result.reason || '') : '',
        }).catch(() => {});
        continue;
      }
      const adapter = deps.getAdapter(provider);
      if (!adapter || typeof adapter.adjustStock !== 'function') {
        items.push({ provider, skipped: true, reason: 'no_adapter' });
        continue;
      }
      const context = await adapterContext({ deps, firestore, provider, sellerUid, cache: contexts });
      const result = await adapter.adjustStock(context, { link, delta: amount, reason });
      items.push({ provider, delta: amount, ...(result || { ok: true }) });
      await deps.links.markPushed({
        listingId,
        provider,
        error: result && result.ok === false ? String(result.error || result.reason || '') : '',
      }).catch(() => {});
    } catch (error) {
      items.push({ provider, ok: false, error: error.message });
      await deps.links.markPushed({ listingId, provider, error: error.message }).catch(() => {});
    }
  }

  if (includeCardTrader && originId !== 'cardtrader' && !sawCardTraderLink) {
    const source = await resolveSourceListingId({ deps, listingId, sourceListingId });
    if (isCardTraderSource(source)) {
      try {
        const result = await adjustCardTraderLink({
          deps,
          firestore,
          sellerUid,
          sourceListingId: source,
          delta: amount,
        });
        items.push({ provider: 'cardtrader', delta: amount, ...(result || { ok: true }) });
      } catch (error) {
        items.push({ provider: 'cardtrader', ok: false, error: error.message });
      }
    }
  }

  return { ok: items.every((row) => row.ok !== false || row.skipped), items };
}

/** `source_listing_id` for the CardTrader extra fan-out target. */
async function resolveSourceListingId({ deps, listingId, sourceListingId }) {
  const explicit = cleanText(sourceListingId, 160);
  if (explicit) return explicit;
  try {
    const result = await writeExecutor(deps, null)(LISTING_SOURCE_SQL, [listingId]);
    return cleanText(result?.rows?.[0]?.source_listing_id, 160);
  } catch (_) {
    return '';
  }
}

/** Firestore Sold-history row, keyed provider + order + item. */
async function recordPlatformSale({
  firestore,
  admin,
  provider,
  sellerUid,
  orderId,
  itemId,
  listing = {},
  quantity,
  unitPriceCents = 0,
  currency = '',
  soldAt = null,
}) {
  if (!firestore) return { ok: false, skipped: true, reason: 'no_firestore' };
  const id = saleDocId(provider, orderId, itemId);
  const now = admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date().toISOString();
  const data = {
    orderId: `${cleanText(provider, 40)}_${cleanText(orderId, 160)}`,
    externalOrderId: cleanText(orderId, 160),
    externalItemId: cleanText(itemId, 160),
    listingId: String(listing.id || ''),
    cardId: cleanText(listing.card_id, 120),
    sellerUid: cleanText(sellerUid, 160),
    quantity: positiveInt(quantity) || 1,
    unitPriceCents: Math.round(Number(unitPriceCents) || 0),
    currency: cleanText(currency, 8),
    source: cleanText(provider, 40),
    provider: cleanText(provider, 40),
    voided: false,
    soldAt: soldAt || now,
    updatedAt: now,
  };
  await firestore.collection(SALES_COLLECTION).doc(id).set(data, { merge: true });
  return { ok: true, id };
}

async function voidPlatformSale({ firestore, admin, provider, orderId, itemId, reason }) {
  if (!firestore) return { ok: false, skipped: true, reason: 'no_firestore' };
  const id = saleDocId(provider, orderId, itemId);
  const now = admin?.firestore?.FieldValue?.serverTimestamp?.() || new Date().toISOString();
  await firestore.collection(SALES_COLLECTION).doc(id).set({
    voided: true,
    voidReason: cleanText(reason, 80),
    updatedAt: now,
  }, { merge: true }).catch(() => {});
  return { ok: true, id };
}

/** Price summary + Redis invalidation after Pokoin stock moved. */
async function afterStockChange({ deps, listing, sellerUid, reason }) {
  const cardId = cleanText(listing?.card_id, 120);
  if (typeof deps.refreshPriceSummary === 'function') {
    await Promise.resolve(deps.refreshPriceSummary(cardId)).catch(() => {});
  }
  const invalidate = deps.invalidateCache
    || ((args) => require('./_marketplace_cache_invalidate').invalidateMarketplaceReads(args));
  await Promise.resolve(invalidate({ game: 'pokemon', cardId, sellerUid, reason })).catch(() => {});
}

/** Resolve a Pokoin listing id for one provider item, or null (never guess). */
async function resolveListingId({ deps, provider, sellerUid, listingId, externalId, sku }) {
  const explicit = cleanText(listingId, 160);
  if (explicit) return explicit;
  const external = cleanText(externalId, 160) || cleanText(sku, 160);
  if (!external) return null;
  const link = await deps.links.findLinkByExternal({
    sellerUid,
    provider,
    externalId: external,
  }, writeExecutor(deps, null));
  return link?.listing_id ? String(link.listing_id) : null;
}

function assertProvider(provider) {
  const id = cleanText(provider, 40);
  if (!id) return { ok: false, reason: 'unknown_provider' };
  if (id === 'cardtrader') return { ok: false, reason: 'cardtrader_uses_own_path' };
  return { ok: true, id };
}

/**
 * An external sale: claim, take the quantity off Pokoin, write the Sold row,
 * then push the delta to every other platform (CardTrader included).
 */
async function applyExternalSale({
  provider,
  sellerUid,
  orderId,
  itemId,
  listingId = '',
  externalId = '',
  sku = '',
  quantity,
  unitPriceCents = 0,
  currency = '',
  soldAt = null,
  firestore,
  admin,
  deps: overrides = {},
} = {}) {
  const deps = resolveDeps(overrides);
  const known = assertProvider(provider);
  if (!known.ok) return { ok: false, applied: false, reason: known.reason };
  const qty = positiveInt(quantity);
  if (!qty) return { ok: false, applied: false, reason: 'invalid_quantity' };
  const seller = cleanText(sellerUid, 160);
  const order = cleanText(orderId, 160);
  const item = cleanText(itemId, 160);
  if (!order || !item || !seller) {
    return { ok: false, applied: false, reason: 'missing_identity' };
  }

  const target = await resolveListingId({
    deps,
    provider: known.id,
    sellerUid: seller,
    listingId,
    externalId,
    sku,
  });
  if (!target) return { ok: true, applied: false, skipped: true, reason: 'unmatched_item' };

  const claim = await inTransaction(deps, async (client) => {
    const exec = writeExecutor(deps, client);
    const claimed = await deps.links.claimEvent({
      sellerUid: seller,
      provider: known.id,
      orderId: order,
      itemId: item,
      kind: 'sale',
      listingId: target,
      quantity: qty,
    }, exec);
    if (!claimed) return { claimed: false };
    const result = await exec(DECREMENT_LISTING_SQL, [known.id, target, qty, seller]);
    return { claimed: true, row: result?.rows?.[0] || null };
  });
  if (!claim.claimed) return { ok: true, applied: false, duplicate: true };
  if (!claim.row) {
    // Failed decrement: drop the claim so a retry can succeed.
    await deps.links.releaseEvent({
      sellerUid: seller,
      provider: known.id,
      orderId: order,
      itemId: item,
      kind: 'sale',
    }, writeExecutor(deps, null)).catch(() => {});
    return { ok: false, applied: false, reason: 'insufficient_stock', released: true };
  }

  const listing = claim.row;
  await recordPlatformSale({
    firestore,
    admin,
    provider: known.id,
    sellerUid: seller,
    orderId: order,
    itemId: item,
    listing,
    quantity: qty,
    unitPriceCents,
    currency,
    soldAt,
  }).catch(() => {});

  const fanout = await fanOutStockChange({
    origin: known.id,
    sellerUid: seller,
    listingId: target,
    sourceListingId: listing.source_listing_id,
    delta: -qty,
    includeCardTrader: true,
    reason: `${known.id}_sale`,
    firestore,
    deps,
  });
  await afterStockChange({ deps, listing, sellerUid: seller, reason: `${known.id}_sale` });
  return { ok: true, applied: true, quantity: qty, listing, fanout };
}

/**
 * An external cancel/refund: restore stock at most once, and only when the sale
 * claim exists.
 */
async function applyExternalCancel({
  provider,
  sellerUid,
  orderId,
  itemId,
  listingId = '',
  externalId = '',
  sku = '',
  quantity,
  firestore,
  admin,
  deps: overrides = {},
} = {}) {
  const deps = resolveDeps(overrides);
  const known = assertProvider(provider);
  if (!known.ok) return { ok: false, applied: false, reason: known.reason };
  const seller = cleanText(sellerUid, 160);
  const order = cleanText(orderId, 160);
  const item = cleanText(itemId, 160);
  if (!order || !item || !seller) {
    return { ok: false, applied: false, reason: 'missing_identity' };
  }

  const sale = await deps.links.findEvent({
    sellerUid: seller,
    provider: known.id,
    orderId: order,
    itemId: item,
    kind: 'sale',
  }, writeExecutor(deps, null));
  if (!sale) return { ok: true, applied: false, skipped: true, reason: 'no_sale_claim' };

  const target = cleanText(listingId, 160) || String(sale.listing_id || '');
  if (!target) return { ok: true, applied: false, skipped: true, reason: 'no_listing' };
  const qty = positiveInt(quantity) || positiveInt(sale.quantity) || 1;

  const claim = await inTransaction(deps, async (client) => {
    const exec = writeExecutor(deps, client);
    const claimed = await deps.links.claimEvent({
      sellerUid: seller,
      provider: known.id,
      orderId: order,
      itemId: item,
      kind: 'cancel',
      listingId: target,
      quantity: qty,
    }, exec);
    if (!claimed) return { claimed: false };
    const result = await exec(RESTORE_LISTING_SQL, [known.id, target, qty, seller]);
    return { claimed: true, row: result?.rows?.[0] || null };
  });
  if (!claim.claimed) return { ok: true, applied: false, duplicate: true };
  if (!claim.row) {
    await deps.links.releaseEvent({
      sellerUid: seller,
      provider: known.id,
      orderId: order,
      itemId: item,
      kind: 'cancel',
    }, writeExecutor(deps, null)).catch(() => {});
    return { ok: false, applied: false, reason: 'listing_missing', released: true };
  }

  const listing = claim.row;
  await voidPlatformSale({
    firestore,
    admin,
    provider: known.id,
    orderId: order,
    itemId: item,
    reason: `${known.id}_order_cancelled`,
  });
  const fanout = await fanOutStockChange({
    origin: known.id,
    sellerUid: seller,
    listingId: target,
    sourceListingId: listing.source_listing_id,
    delta: qty,
    includeCardTrader: true,
    reason: `${known.id}_cancel`,
    firestore,
    deps,
  });
  await afterStockChange({ deps, listing, sellerUid: seller, reason: `${known.id}_cancel` });
  return { ok: true, applied: true, restored: qty, listing, fanout };
}

/**
 * Poll one provider for paid orders. An incomplete read is reported and never
 * applied: only individual sold order items move stock, never "absent from a
 * listing".
 */
async function pollProvider({
  provider,
  firestore,
  admin,
  sellerUid = '',
  since = null,
  now = () => new Date().toISOString(),
  deps: overrides = {},
} = {}) {
  const deps = resolveDeps(overrides);
  const providerId = cleanText(provider, 40);
  if (!firestore) return { ok: false, skipped: true, reason: 'no_firestore', provider: providerId };

  const doc = await deps.integrations.readIntegration(firestore, sellerUid, providerId);
  if (!doc || !doc.exists || doc.data()?.enabled !== true) {
    return { ok: true, skipped: true, reason: 'not_connected', provider: providerId };
  }
  const data = doc.data() || {};
  const uid = cleanText(sellerUid, 160) || cleanText(data.uid, 160);

  const adapter = deps.getAdapter(providerId);
  if (!adapter || typeof adapter.fetchSoldItems !== 'function') {
    return { ok: true, skipped: true, reason: 'no_poller', provider: providerId };
  }

  const credentials = await deps.integrations.decryptSecrets(firestore, uid, providerId);
  // Capture the window start before the fetch: everything returned happened
  // before this moment, so the next poll must not re-read past it.
  const startedAt = now();
  const fallbackSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const reading = await adapter.fetchSoldItems(
    { credentials, metadata: data.metadata || {}, fetchFn: deps.fetchFn || fetch },
    { since: since || toIso(data.lastPolledAt) || toIso(data.connectedAt) || fallbackSince },
  );
  if (!reading || reading.complete !== true) {
    return {
      ok: true,
      complete: false,
      skipped: true,
      reason: 'incomplete_read',
      provider: providerId,
      sales: (reading?.sales || []).length,
      cancels: (reading?.cancels || []).length,
    };
  }

  const results = [];
  for (const raw of reading.sales || []) {
    results.push(await applyExternalSale({
      ...normalizeSoldItem(raw),
      provider: providerId,
      sellerUid: uid,
      firestore,
      admin,
      deps,
    }));
  }
  for (const raw of reading.cancels || []) {
    results.push(await applyExternalCancel({
      ...normalizeSoldItem(raw),
      provider: providerId,
      sellerUid: uid,
      firestore,
      admin,
      deps,
    }));
  }

  if (deps.integrations && typeof deps.integrations.patchIntegration === 'function') {
    await deps.integrations
      .patchIntegration(firestore, uid, providerId, { lastPolledAt: startedAt })
      .catch(() => {});
  }

  return {
    ok: results.every((row) => row.ok !== false || row.skipped || row.duplicate),
    complete: true,
    provider: providerId,
    applied: results.filter((row) => row.applied).length,
    results,
  };
}

module.exports = {
  SALES_COLLECTION,
  DECREMENT_LISTING_SQL,
  RESTORE_LISTING_SQL,
  saleDocId,
  normalizeSoldItem,
  fanOutStockChange,
  applyExternalSale,
  applyExternalCancel,
  pollProvider,
};
