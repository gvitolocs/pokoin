'use strict';

/**
 * Backfill real CardTrader sales for one connected seller from their
 * CardTrader seller orders (GET /orders?order_as=seller), not from
 * "vanished from the export".
 *
 *   node api/cardtrader-sales-backfill.js --uid <firebaseUid>            # dry run
 *   node api/cardtrader-sales-backfill.js --uid <firebaseUid> --apply
 *
 * For every sold CardTrader order item of a linked Pokoin listing, created
 * after that listing was imported:
 *   - writes marketplace_sales/ct_{order}__{item} (source cardtrader)
 *   - claims cardtrader_webhook_events so the webhook never counts it twice
 *   - caps the Pokoin quantity at what CardTrader still has (sold_out at 0)
 * Linked listings that left CardTrader with no seller order are delisted, not
 * sold: they become status inactive so they never read as sales.
 */

// Runtime-only helpers (Firebase/Postgres/CT token) load inside main() so the
// pure planner stays unit-testable outside the API image.
const { cleanText, eventDocId, itemProductId, itemUserDataField, orderItemId } = require('./_cardtrader_webhook_core');
const { cardTraderSaleDoc, SALES_COLLECTION } = require('./_native_sales');

const CARDTRADER_API = 'https://api.cardtrader.com/api/v2';
const NOT_SOLD_STATES = new Set(['pending', 'canceled', 'cancelled', 'request_for_cancel_accepted']);

// Same shape as _cardtrader_seller_listings.parsePokoinListingId (that module
// needs the API image's Postgres helper at load time).
function parsePokoinListingId(userDataField) {
  const match = cleanText(userDataField, 160).match(/^pokoin:([0-9a-f-]{36})$/i);
  return match ? match[1] : '';
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '') : '';
}

function orderItemIsSale(order = {}) {
  return !NOT_SOLD_STATES.has(cleanText(order.state, 40).toLowerCase());
}

/** Sold only counts once the card was a Pokoin listing. */
function soldAfterImport(item = {}, listing = {}) {
  const sold = new Date(item.created_at || 0).getTime();
  const listed = new Date(listing.created_at || 0).getTime();
  return Number.isFinite(sold) && Number.isFinite(listed) && sold >= listed;
}

/** New Pokoin quantity: never above what CardTrader still holds. */
function cappedQuantity(listing = {}, ctQuantity = 0) {
  const current = Math.max(0, Number(listing.quantity_available) || 0);
  return Math.min(current, Math.max(0, Number(ctQuantity) || 0));
}

async function fetchSellerOrders(token, { fetchImpl = fetch, pageSize = 100, maxPages = 50 } = {}) {
  const orders = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(
      `${CARDTRADER_API}/orders?order_as=seller&sort=date.desc&limit=${pageSize}&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`CardTrader orders page ${page} failed: ${response.status}`);
    const body = await response.json();
    const rows = Array.isArray(body) ? body : [];
    orders.push(...rows);
    if (rows.length < pageSize) break;
  }
  return orders;
}

async function linkedListingsForSeller(uid, query) {
  const result = await query(
    `
      select l.id, l.card_id, l.quantity_available, l.status, l.source_listing_id, l.created_at,
             link.ct_product_id
      from public.marketplace_user_listings l
      left join public.marketplace_cardtrader_product_links link
        on link.listing_id = l.id and link.seller_uid = l.seller_uid
      where l.seller_uid = $1
        and (link.ct_product_id is not null or l.source_listing_id like 'ct:%')
    `,
    [uid],
  );
  const byId = new Map();
  const byProduct = new Map();
  for (const row of result.rows) {
    byId.set(row.id, row);
    const productId = cleanText(row.ct_product_id || String(row.source_listing_id || '').replace(/^ct:/, ''), 40);
    if (productId) byProduct.set(productId, row);
  }
  return { byId, byProduct };
}

function listingForItem(item, maps) {
  const listingId = parsePokoinListingId(itemUserDataField(item));
  if (listingId && maps.byId.has(listingId)) return maps.byId.get(listingId);
  return maps.byProduct.get(cleanText(itemProductId(item), 40)) || null;
}

/** Pure plan so the dry run and the apply path can never disagree. */
function planBackfill({ orders, maps, exportQuantities, claimedEventIds, uid }) {
  const sales = [];
  const soldListingIds = new Set();
  for (const order of orders) {
    if (!orderItemIsSale(order)) continue;
    for (const item of Array.isArray(order.order_items) ? order.order_items : []) {
      const listing = listingForItem(item, maps);
      if (!listing || !soldAfterImport(item, listing)) continue;
      soldListingIds.add(listing.id);
      const eventId = eventDocId(uid, order.id, orderItemId(item));
      if (claimedEventIds.has(eventId)) continue;
      sales.push({ order, item, listing, eventId });
    }
  }
  const stock = [];
  const delisted = [];
  for (const listing of maps.byId.values()) {
    const productId = cleanText(listing.ct_product_id || String(listing.source_listing_id || '').replace(/^ct:/, ''), 40);
    const ctQty = exportQuantities.get(productId) || 0;
    const live = listing.status === 'active' || listing.status === 'paused';
    if (live && Number(listing.quantity_available) > ctQty) {
      stock.push({ listing, quantity: cappedQuantity(listing, ctQty) });
    }
    // Gone from CardTrader with no seller order → removed by the seller, not sold.
    if (ctQty === 0 && !soldListingIds.has(listing.id) && (live || listing.status === 'sold_out')) {
      delisted.push({ listing });
    }
  }
  return { sales, stock, delisted };
}

async function main(argv = process.argv.slice(2)) {
  const uid = cleanText(argValue(argv, '--uid'), 160);
  const apply = argv.includes('--apply');
  if (!uid) throw new Error('--uid is required');
  const { getFirebaseAdmin } = require('../server/_firebase');
  const { marketplaceQuery, marketplaceWriteQuery } = require('../server/_marketplace_db');
  const { decryptIntegrationToken } = require('./_cardtrader_integration');
  const { fetchProductsExport } = require('./_cardtrader_client');
  const admin = getFirebaseAdmin();
  const firestore = admin.firestore();
  const token = await decryptIntegrationToken(firestore, uid);

  const [orders, exportRows, maps, events] = await Promise.all([
    fetchSellerOrders(token),
    fetchProductsExport(token),
    linkedListingsForSeller(uid, marketplaceQuery),
    firestore.collection('cardtrader_webhook_events').where('uid', '==', uid).get(),
  ]);
  const exportQuantities = new Map(exportRows.map((row) => [cleanText(row.id, 40), Number(row.quantity) || 0]));
  const claimedEventIds = new Set(events.docs.map((doc) => doc.id));
  const plan = planBackfill({ orders, maps, exportQuantities, claimedEventIds, uid });

  console.log('cardtrader sales backfill plan', {
    uid,
    apply,
    ctOrders: orders.length,
    linkedListings: maps.byId.size,
    newSales: plan.sales.length,
    stockCaps: plan.stock.length,
    delisted: plan.delisted.length,
  });
  for (const row of plan.sales) {
    console.log('sale', row.order.id, row.order.state, row.item.name, 'listing', row.listing.id, row.listing.status);
  }
  for (const row of plan.stock) {
    console.log('cap', row.listing.id, row.listing.quantity_available, '→', row.quantity);
  }
  for (const row of plan.delisted) {
    console.log('delisted (not sold)', row.listing.id, row.listing.status);
  }
  if (!apply) return plan;

  for (const row of plan.sales) {
    const sale = cardTraderSaleDoc({ sellerUid: uid, order: row.order, item: row.item, listing: row.listing });
    await firestore.collection(SALES_COLLECTION).doc(sale.id).set({
      ...sale.data,
      backfill: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await firestore.collection('cardtrader_webhook_events').doc(row.eventId).set({
      uid,
      orderId: String(row.order.id),
      orderItemId: orderItemId(row.item),
      cause: 'backfill',
      listingId: row.listing.id,
      quantity: Number(row.item.quantity) || 1,
      productId: itemProductId(row.item),
      createdAt: new Date().toISOString(),
    }, { merge: true });
  }
  for (const row of plan.stock) {
    await marketplaceWriteQuery(
      `
        update public.marketplace_user_listings
        set quantity_available = $2,
            status = case when $2 <= 0 then 'sold_out' else status end,
            updated_at = now()
        where id = $1 and seller_uid = $3
      `,
      [row.listing.id, row.quantity, uid],
    );
  }
  for (const row of plan.delisted) {
    await marketplaceWriteQuery(
      `
        update public.marketplace_user_listings
        set quantity_available = 0, status = 'inactive', updated_at = now()
        where id = $1 and seller_uid = $2 and status in ('active', 'paused', 'sold_out')
      `,
      [row.listing.id, uid],
    );
  }
  const cardIds = [...new Set([...plan.stock, ...plan.delisted].map((row) => row.listing.card_id).filter(Boolean))];
  for (const cardId of cardIds) {
    await marketplaceWriteQuery('select public.refresh_marketplace_blueprint_price_summary($1)', [cardId])
      .catch((error) => console.error('price summary refresh failed', cardId, error.message));
  }
  console.log('cardtrader sales backfill applied', {
    sales: plan.sales.length,
    stockCaps: plan.stock.length,
    delisted: plan.delisted.length,
  });
  return plan;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error('cardtrader sales backfill failed', error.message);
    process.exit(1);
  });
}

module.exports = {
  cappedQuantity,
  listingForItem,
  orderItemIsSale,
  planBackfill,
  soldAfterImport,
};
